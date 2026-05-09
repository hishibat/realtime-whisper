"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/auth";

type Status = "idle" | "connecting" | "recording" | "stopping" | "error";
type Lang = "ja" | "en";

const PLACEHOLDER: Record<Lang, string> = {
  ja: "ここに文字起こしがリアルタイムで表示されます。録音を開始してください。",
  en: "Live transcript will appear here. Press Start to begin.",
};

const TARGET_SAMPLE_RATE = 24000;

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsampleTo24k(buffer: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_SAMPLE_RATE) return buffer;
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const newLen = Math.floor(buffer.length / ratio);
  const out = new Float32Array(newLen);
  let sum = 0;
  let count = 0;
  let nextBoundary = ratio;
  let outIdx = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i];
    count++;
    if (i + 1 >= nextBoundary) {
      out[outIdx++] = count > 0 ? sum / count : 0;
      if (outIdx >= newLen) break;
      sum = 0;
      count = 0;
      nextBoundary += ratio;
    }
  }
  return out;
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [language, setLanguage] = useState<Lang>("ja");
  const [finalSegments, setFinalSegments] = useState<string[]>([]);
  const [partial, setPartial] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<number>(18);
  const [toast, setToast] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
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
      processorRef.current?.disconnect();
    } catch {}
    try {
      sourceRef.current?.disconnect();
    } catch {}
    try {
      audioCtxRef.current?.close();
    } catch {}
    try {
      // Send a normal-close (1000) so the server sees a graceful shutdown
      // and the browser doesn't synthesize the 1005 "no status" placeholder.
      wsRef.current?.close(1000, "client stop");
    } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    processorRef.current = null;
    sourceRef.current = null;
    audioCtxRef.current = null;
    wsRef.current = null;
    streamRef.current = null;
    partialMapRef.current.clear();
    setPartial("");
  }, []);

  const handleEvent = useCallback((evt: { type?: string; [k: string]: unknown }) => {
    if (!evt || typeof evt !== "object") return;
    const type = (evt.type as string) || "";

    if (type.endsWith("input_audio_transcription.delta")) {
      const id = (evt.item_id as string) || "default";
      const prev = partialMapRef.current.get(id) || "";
      const next = prev + ((evt.delta as string) || "");
      partialMapRef.current.set(id, next);
      const merged = Array.from(partialMapRef.current.values()).join("");
      setPartial(merged);
      return;
    }

    if (type.endsWith("input_audio_transcription.completed")) {
      const id = (evt.item_id as string) || "default";
      const transcript =
        (typeof evt.transcript === "string" && (evt.transcript as string)) ||
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
      const errObj = evt.error as { message?: string } | undefined;
      const msg = errObj?.message || "Transcription failed for one segment.";
      setError((prev) => (prev ? prev + "\n" + msg : msg));
      return;
    }

    if (type === "error") {
      const errObj = evt.error as { message?: string; code?: string; type?: string } | undefined;
      const raw = errObj?.message || "Realtime API error.";
      const code = errObj?.code || "";
      const isQuota =
        code === "insufficient_quota" ||
        /exceeded your current quota/i.test(raw) ||
        /quota/i.test(code);
      if (isQuota) {
        setError(
          "OpenAIのクォータ不足です (insufficient_quota)。\n" +
            "考えられる原因と対処（上から順に確認推奨）:\n" +
            "1) Project単位の月次予算が$0のまま → https://platform.openai.com/settings/organization/projects で該当projectを開き Limits → Monthly budget を$10以上に設定\n" +
            "2) APIキーが Credit を入れた組織と別orgに属している → 右上のorg切替で確認\n" +
            "3) クレジット反映遅延 → 5〜15分待って再試行\n" +
            "\n生メッセージ: " +
            raw
        );
      } else {
        setError(raw);
      }
      return;
    }
  }, []);

  const start = useCallback(async () => {
    if (status === "connecting" || status === "recording") return;
    setError(null);
    setStatus("connecting");

    try {
      // 1. Get ephemeral key.
      let r: Response;
      try {
        r = await authFetch(`/api/session?language=${language}`, { method: "POST" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`[session] network error: ${msg}`);
      }
      if (r.status === 401) {
        throw new Error("[session] Unauthorized — please re-enter the passphrase.");
      }
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`[session] HTTP ${r.status}: ${t}`);
      }
      const j = await r.json();
      const ephemeralKey: string | undefined = j.client_secret;
      if (!ephemeralKey) throw new Error("[session] No ephemeral key returned");

      // 2. Mic.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`[mic] ${msg}`);
      }
      streamRef.current = stream;

      // 3. WebSocket. OpenAI-specific browser auth via subprotocol.
      // NOTE: Do NOT add "openai-beta.realtime-v1" — the Realtime API has
      // graduated to GA. Including the beta marker triggers
      // invalid_request_error.api_version_mismatch (code 4000) because
      // /v1/realtime/client_secrets now issues GA-tier ephemeral keys.
      const ws = new WebSocket("wss://api.openai.com/v1/realtime", [
        "realtime",
        `openai-insecure-api-key.${ephemeralKey}`,
      ]);
      wsRef.current = ws;

      const opened = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("[ws] open timeout (8s)")), 8000);
        ws.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("[ws] connection error"));
        });
      });

      ws.addEventListener("message", (ev) => {
        try {
          const evt = JSON.parse(ev.data);
          handleEvent(evt);
        } catch {}
      });

      ws.addEventListener("close", (ev) => {
        // 1000 = explicit normal close; 1005 = no status received (browser
        // synthesizes this when our own ws.close() ran without a code, or
        // the server closed without a frame). Both are benign.
        const benign = ev.code === 1000 || ev.code === 1005;
        if (!benign) {
          setError(
            (prev) =>
              `[ws] closed code=${ev.code} reason=${ev.reason || "(none)"}` +
              (prev ? "\n" + prev : "")
          );
        }
        setStatus((cur) => (cur === "recording" || cur === "connecting" ? "idle" : cur));
      });

      await opened;

      // 4. Send session.update for transcription.
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: TARGET_SAMPLE_RATE },
                transcription: {
                  model: "gpt-realtime-whisper",
                  language,
                },
              },
            },
          },
        })
      );

      // 5. Audio pipeline: capture, downsample to 24k mono PCM16, base64, send.
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo24k(input, audioCtx.sampleRate);
        if (downsampled.length === 0) return;
        const pcm16 = floatTo16BitPCM(downsampled);
        const b64 = int16ToBase64(pcm16);
        ws.send(
          JSON.stringify({ type: "input_audio_buffer.append", audio: b64 })
        );
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      setStatus("recording");
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
          <h1>
            Realtime Whisper{" "}
            <span style={{ color: "var(--muted)", fontSize: 12, fontWeight: 400 }}>
              v1
            </span>
          </h1>
          <div className="sub">OpenAI gpt-realtime-whisper · WebSocket streaming</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a href="/v2" className="ver-link">
            → {language === "ja" ? "v2 (新機能版)へ" : "v2 (enhanced)"}
          </a>
          <span className={`status-pill ${status}`}>
            <span className="dot" />
            {status === "idle" && (language === "ja" ? "待機中" : "Idle")}
            {status === "connecting" && (language === "ja" ? "接続中…" : "Connecting…")}
            {status === "recording" && (language === "ja" ? "録音中" : "Recording")}
            {status === "stopping" && (language === "ja" ? "停止中…" : "Stopping…")}
            {status === "error" && (language === "ja" ? "エラー" : "Error")}
          </span>
        </div>
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
          <button className="btn danger" onClick={stop}>
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
