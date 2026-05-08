"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "connecting" | "recording" | "stopping" | "error";
type Lang = "ja" | "en";

const PLACEHOLDER: Record<Lang, string> = {
  ja: "ここに文字起こしがリアルタイムで表示されます。録音を開始してください。",
  en: "Live transcript will appear here. Press Start to begin.",
};

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [language, setLanguage] = useState<Lang>("ja");
  const [finalSegments, setFinalSegments] = useState<string[]>([]);
  const [partial, setPartial] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<number>(18);
  const [toast, setToast] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const partialMapRef = useRef<Map<string, string>>(new Map());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef<boolean>(true);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1400);
  }, []);

  const teardown = useCallback(() => {
    try {
      dcRef.current?.close();
    } catch {}
    try {
      pcRef.current?.getSenders().forEach((s) => s.track && s.track.stop());
    } catch {}
    try {
      pcRef.current?.close();
    } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    pcRef.current = null;
    dcRef.current = null;
    streamRef.current = null;
    partialMapRef.current.clear();
    setPartial("");
  }, []);

  const handleEvent = useCallback((evt: any) => {
    if (!evt || typeof evt !== "object") return;
    const type: string = evt.type || "";

    if (type.endsWith("input_audio_transcription.delta")) {
      const id: string = evt.item_id || "default";
      const prev = partialMapRef.current.get(id) || "";
      const next = prev + (evt.delta || "");
      partialMapRef.current.set(id, next);
      const merged = Array.from(partialMapRef.current.values()).join("");
      setPartial(merged);
      return;
    }

    if (type.endsWith("input_audio_transcription.completed")) {
      const id: string = evt.item_id || "default";
      const transcript: string =
        (typeof evt.transcript === "string" && evt.transcript) ||
        partialMapRef.current.get(id) ||
        "";
      partialMapRef.current.delete(id);
      const remainingPartial = Array.from(partialMapRef.current.values()).join("");
      setPartial(remainingPartial);
      const trimmed = transcript.trim();
      if (trimmed.length > 0) {
        setFinalSegments((prev) => [...prev, trimmed]);
      }
      return;
    }

    if (type.endsWith("input_audio_transcription.failed")) {
      const msg = evt?.error?.message || "Transcription failed for one segment.";
      setError((prev) => (prev ? prev + "\n" + msg : msg));
      return;
    }

    if (type === "error") {
      const msg = evt?.error?.message || "Realtime API error.";
      setError(msg);
      return;
    }
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "recording") return;
    setError(null);
    setStatus("connecting");

    try {
      // 1. Get ephemeral key from our backend.
      const r = await fetch(`/api/session?language=${language}`, { method: "POST" });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Session creation failed (${r.status}): ${t}`);
      }
      const j = await r.json();
      const ephemeralKey: string | undefined = j.client_secret;
      if (!ephemeralKey) throw new Error("No ephemeral key returned from /api/session");

      // 2. Acquire mic.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // 3. Setup peer connection.
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.addEventListener("connectionstatechange", () => {
        const s = pc.connectionState;
        if (s === "failed" || s === "disconnected" || s === "closed") {
          if (status !== "stopping") {
            setStatus((cur) => (cur === "recording" ? "idle" : cur));
          }
        }
      });

      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      // 4. Data channel for events.
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.addEventListener("open", () => {
        // Reinforce session config (idempotent — also embedded in ephemeral token).
        try {
          dc.send(
            JSON.stringify({
              type: "session.update",
              session: {
                type: "transcription",
                audio: {
                  input: {
                    transcription: {
                      model: "gpt-realtime-whisper",
                      language,
                    },
                    turn_detection: {
                      type: "server_vad",
                      threshold: 0.5,
                      prefix_padding_ms: 300,
                      silence_duration_ms: 500,
                    },
                  },
                },
              },
            })
          );
        } catch {}
        setStatus("recording");
      });

      dc.addEventListener("message", (ev) => {
        try {
          const evt = JSON.parse(ev.data);
          handleEvent(evt);
        } catch {}
      });

      dc.addEventListener("close", () => {
        setStatus((cur) => (cur === "recording" ? "idle" : cur));
      });

      // 5. SDP exchange.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResp = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
      });
      if (!sdpResp.ok) {
        const t = await sdpResp.text();
        throw new Error(`SDP exchange failed (${sdpResp.status}): ${t}`);
      }
      const answerSdp = await sdpResp.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus("error");
      teardown();
    }
  }, [status, language, handleEvent, teardown]);

  const stop = useCallback(() => {
    setStatus("stopping");
    teardown();
    setStatus("idle");
  }, [teardown]);

  const fullText = useCallback(() => {
    const finals = finalSegments.join("\n");
    if (!partial) return finals;
    return finals ? finals + "\n" + partial : partial;
  }, [finalSegments, partial]);

  const copyAll = useCallback(async () => {
    const text = fullText();
    if (!text) {
      showToast(language === "ja" ? "コピーする内容がありません" : "Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(language === "ja" ? "コピーしました" : "Copied");
    } catch {
      // Fallback: textarea + execCommand.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        showToast(language === "ja" ? "コピーしました" : "Copied");
      } catch {
        showToast(language === "ja" ? "コピー失敗" : "Copy failed");
      }
      document.body.removeChild(ta);
    }
  }, [fullText, showToast, language]);

  const clearAll = useCallback(() => {
    setFinalSegments([]);
    setPartial("");
    partialMapRef.current.clear();
  }, []);

  // Auto-scroll transcript to bottom while user hasn't scrolled up.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    if (autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [finalSegments, partial]);

  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = nearBottom;
  }, []);

  // Cleanup on unmount.
  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  const recording = status === "recording";
  const connecting = status === "connecting";
  const isEmpty = finalSegments.length === 0 && !partial;

  const wordCount = (() => {
    const t = fullText();
    if (!t) return 0;
    return language === "en" ? t.trim().split(/\s+/).filter(Boolean).length : t.length;
  })();

  return (
    <main>
      <header className="app-header">
        <div>
          <h1>Realtime Whisper</h1>
          <div className="sub">OpenAI gpt-realtime-whisper · WebRTC streaming</div>
        </div>
        <span className={`status-pill ${status}`}>
          <span className="dot" />
          {status === "idle" && (language === "ja" ? "待機中" : "Idle")}
          {status === "connecting" && (language === "ja" ? "接続中…" : "Connecting…")}
          {status === "recording" && (language === "ja" ? "録音中" : "Recording")}
          {status === "stopping" && (language === "ja" ? "停止中…" : "Stopping…")}
          {status === "error" && (language === "ja" ? "エラー" : "Error")}
        </span>
      </header>

      <div className="toolbar">
        <div className="lang-toggle" role="group" aria-label="Language">
          <button
            className={language === "ja" ? "active" : ""}
            onClick={() => setLanguage("ja")}
            disabled={recording || connecting}
            aria-pressed={language === "ja"}
          >
            日本語
          </button>
          <button
            className={language === "en" ? "active" : ""}
            onClick={() => setLanguage("en")}
            disabled={recording || connecting}
            aria-pressed={language === "en"}
          >
            English
          </button>
        </div>

        {!recording && !connecting ? (
          <button className="btn primary" onClick={start} disabled={status === "stopping"}>
            ● {language === "ja" ? "録音開始" : "Start"}
          </button>
        ) : (
          <button className="btn danger" onClick={stop} disabled={connecting && !recording ? false : false}>
            ■ {language === "ja" ? "停止" : "Stop"}
          </button>
        )}

        <button className="btn" onClick={copyAll} disabled={isEmpty}>
          {language === "ja" ? "全文コピー" : "Copy all"}
        </button>

        <button className="btn" onClick={clearAll} disabled={isEmpty || recording || connecting}>
          {language === "ja" ? "クリア" : "Clear"}
        </button>

        <div style={{ flex: 1 }} />

        <button
          className="btn"
          onClick={() => setFontSize((s) => Math.max(12, s - 2))}
          aria-label="Decrease font size"
          title={language === "ja" ? "文字を小さく" : "Smaller text"}
        >
          A−
        </button>
        <button
          className="btn"
          onClick={() => setFontSize((s) => Math.min(40, s + 2))}
          aria-label="Increase font size"
          title={language === "ja" ? "文字を大きく" : "Larger text"}
        >
          A+
        </button>
      </div>

      <div className="transcript-wrap">
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="transcript"
          style={{ fontSize: `${fontSize}px` }}
        >
          {isEmpty ? (
            <span className="placeholder">{PLACEHOLDER[language]}</span>
          ) : (
            <>
              {finalSegments.map((seg, i) => (
                <div key={i}>{seg}</div>
              ))}
              {partial && <span className="partial">{partial}</span>}
            </>
          )}
        </div>
      </div>

      <div className="footer-bar">
        <span>
          {language === "ja"
            ? "右下のハンドルでサイズ変更 / 文字数: "
            : "Drag the bottom-right handle to resize · "}
          {wordCount}
          {language === "ja" ? "" : " words"}
        </span>
        <span>
          {language === "ja"
            ? "音声はOpenAIへ直接送信され、サーバーには保存されません。"
            : "Audio streams directly to OpenAI. Nothing is stored on this server."}
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
