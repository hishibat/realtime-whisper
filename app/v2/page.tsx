"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "connecting" | "recording" | "stopping" | "error";
type Lang = "ja" | "en";

type Segment = {
  text: string;
  completedAt: number; // ms epoch when this segment finalized (or was stop-committed)
  speakerIdx: number; // 0..2, determined by inter-segment gap heuristic
};

const PLACEHOLDER: Record<Lang, string> = {
  ja: "ここに文字起こしがリアルタイムで表示されます。録音を開始してください。",
  en: "Live transcript will appear here. Press Start to begin.",
};

const TARGET_SAMPLE_RATE = 24000;
// Inter-segment silence threshold to assume a speaker change.
const SPEAKER_CHANGE_GAP_MS = 1500;
const SPEAKER_PALETTE_SIZE = 3;

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
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

function speakerLabel(idx: number): string {
  return String.fromCharCode(65 + (idx % SPEAKER_PALETTE_SIZE));
}

function nextSpeakerIdx(prev: Segment[], gapMs: number): number {
  if (prev.length === 0) return 0;
  const lastSpk = prev[prev.length - 1].speakerIdx;
  if (gapMs >= SPEAKER_CHANGE_GAP_MS) return (lastSpk + 1) % SPEAKER_PALETTE_SIZE;
  return lastSpk;
}

export default function V2Page() {
  const [status, setStatus] = useState<Status>("idle");
  const [language, setLanguage] = useState<Lang>("ja");
  const [finalSegments, setFinalSegments] = useState<Segment[]>([]);
  const [partial, setPartial] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState<number>(18);
  const [toast, setToast] = useState<string | null>(null);
  const [bulletMode, setBulletMode] = useState<boolean>(false);
  const [speakerMode, setSpeakerMode] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const partialMapRef = useRef<Map<string, string>>(new Map());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef<boolean>(true);
  // Mirror finalSegments in a ref so handleEvent (a stable callback) can read
  // the latest list synchronously when computing speakerIdx for new segments.
  const finalSegmentsRef = useRef<Segment[]>([]);

  useEffect(() => {
    finalSegmentsRef.current = finalSegments;
  }, [finalSegments]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1400);
  }, []);

  const teardownNoCommit = useCallback(() => {
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

  // Commits any in-flight partial buffers to finalSegments before tearing
  // down. Called from the stop button so that whatever the speaker was
  // mid-saying is preserved (otherwise it would be lost on WS close).
  const commitInFlightPartials = useCallback(() => {
    const buffers = Array.from(partialMapRef.current.values()).filter(
      (b) => b.trim().length > 0
    );
    if (buffers.length === 0) return;
    const now = Date.now();
    const newSegs: Segment[] = [];
    let working = finalSegmentsRef.current.slice();
    for (const b of buffers) {
      const lastAt =
        working.length > 0 ? working[working.length - 1].completedAt : 0;
      const gap = lastAt > 0 ? now - lastAt : 0;
      const spk = nextSpeakerIdx(working, gap);
      const seg: Segment = { text: b.trim(), completedAt: now, speakerIdx: spk };
      newSegs.push(seg);
      working = [...working, seg];
    }
    setFinalSegments(working);
  }, []);

  const handleEvent = useCallback(
    (evt: { type?: string; [k: string]: unknown }) => {
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
          const now = Date.now();
          const cur = finalSegmentsRef.current;
          const lastAt = cur.length > 0 ? cur[cur.length - 1].completedAt : 0;
          const gap = lastAt > 0 ? now - lastAt : 0;
          const spk = nextSpeakerIdx(cur, gap);
          const seg: Segment = { text: trimmed, completedAt: now, speakerIdx: spk };
          setFinalSegments((prev) => [...prev, seg]);
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
        const errObj = evt.error as
          | { message?: string; code?: string; type?: string }
          | undefined;
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
    },
    []
  );

  const start = useCallback(async () => {
    if (status === "connecting" || status === "recording") return;
    setError(null);
    setStatus("connecting");

    try {
      let r: Response;
      try {
        r = await fetch(`/api/session?language=${language}`, { method: "POST" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`[session] network error: ${msg}`);
      }
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`[session] HTTP ${r.status}: ${t}`);
      }
      const j = await r.json();
      const ephemeralKey: string | undefined = j.client_secret;
      if (!ephemeralKey) throw new Error("[session] No ephemeral key returned");

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
        const benign = ev.code === 1000 || ev.code === 1005;
        if (!benign) {
          setError(
            (prev) =>
              `[ws] closed code=${ev.code} reason=${ev.reason || "(none)"}` +
              (prev ? "\n" + prev : "")
          );
        }
        setStatus((cur) =>
          cur === "recording" || cur === "connecting" ? "idle" : cur
        );
      });

      await opened;

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
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      setStatus("recording");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus("error");
      teardownNoCommit();
    }
  }, [status, language, handleEvent, teardownNoCommit]);

  const stop = useCallback(() => {
    setStatus("stopping");
    // Preserve any in-flight partial text before closing the stream.
    commitInFlightPartials();
    teardownNoCommit();
    setStatus("idle");
  }, [commitInFlightPartials, teardownNoCommit]);

  const formatLineForCopy = useCallback(
    (seg: Segment) => {
      const bullet = bulletMode ? "・" : "";
      const spk = speakerMode ? `[話者${speakerLabel(seg.speakerIdx)}] ` : "";
      return `${bullet}${spk}${seg.text}`;
    },
    [bulletMode, speakerMode]
  );

  const fullTextForCopy = useCallback(() => {
    const sep = bulletMode ? "\n\n" : "\n";
    const lines = finalSegments.map(formatLineForCopy);
    let out = lines.join(sep);
    if (partial) {
      out = out
        ? out + sep + (bulletMode ? "・" : "") + partial
        : (bulletMode ? "・" : "") + partial;
    }
    return out;
  }, [finalSegments, partial, formatLineForCopy, bulletMode]);

  const copyAll = useCallback(async () => {
    const text = fullTextForCopy();
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
  }, [fullTextForCopy, showToast, language]);

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
    return () => teardownNoCommit();
  }, [teardownNoCommit]);

  const recording = status === "recording";
  const connecting = status === "connecting";
  const isEmpty = finalSegments.length === 0 && !partial;

  const wordCount = (() => {
    if (isEmpty) return 0;
    const flat = finalSegments.map((s) => s.text).join(" ") + " " + partial;
    return language === "en"
      ? flat.trim().split(/\s+/).filter(Boolean).length
      : finalSegments.reduce((a, s) => a + s.text.length, 0) + partial.length;
  })();

  return (
    <main>
      <header className="app-header">
        <div>
          <h1>
            Realtime Whisper{" "}
            <span style={{ color: "var(--muted)", fontSize: 12, fontWeight: 400 }}>
              v2
            </span>
          </h1>
          <div className="sub">OpenAI gpt-realtime-whisper · WebSocket streaming</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a href="/" className="ver-link">
            → {language === "ja" ? "v1へ" : "v1"}
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
          <button
            className="btn primary"
            onClick={start}
            disabled={status === "stopping"}
          >
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

        <button
          className="btn"
          onClick={clearAll}
          disabled={isEmpty || recording || connecting}
        >
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

      <div className="toolbar row2">
        <button
          className={`btn toggle${bulletMode ? " on" : ""}`}
          onClick={() => setBulletMode((v) => !v)}
          aria-pressed={bulletMode}
          title={
            language === "ja"
              ? "各セグメントに「・」と空行を入れて読みやすくします"
              : "Prefix each segment with a bullet and add blank lines"
          }
        >
          {language === "ja"
            ? `整形: ${bulletMode ? "箇条書き" : "OFF"}`
            : `Format: ${bulletMode ? "Bullets" : "OFF"}`}
        </button>
        <button
          className={`btn toggle${speakerMode ? " on" : ""}`}
          onClick={() => setSpeakerMode((v) => !v)}
          aria-pressed={speakerMode}
          title={
            language === "ja"
              ? "発話間隔1.5秒以上を話者交代と推定して色分けします"
              : "Color-code segments by inferred speaker (1.5s pause heuristic)"
          }
        >
          {language === "ja"
            ? `話者: ${speakerMode ? "ON" : "OFF"}`
            : `Speakers: ${speakerMode ? "ON" : "OFF"}`}
        </button>
        {speakerMode && (
          <span className="speaker-note-inline">
            {language === "ja"
              ? "※ 発話間隔1.5秒以上を「話者交代」と推定する近似（本物の話者識別ではありません）"
              : "Heuristic: 1.5s pause = speaker change. Not real diarization."}
          </span>
        )}
      </div>

      <div className="transcript-wrap">
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className={`transcript${bulletMode ? " bullets" : ""}`}
          style={{ fontSize: `${fontSize}px` }}
        >
          {isEmpty ? (
            <span className="placeholder">{PLACEHOLDER[language]}</span>
          ) : (
            <>
              {finalSegments.map((seg, i) => {
                const cls =
                  "seg" + (speakerMode ? ` spk-${seg.speakerIdx % SPEAKER_PALETTE_SIZE}` : "");
                return (
                  <div key={i} className={cls}>
                    {speakerMode && (
                      <span className="spk-label">
                        {language === "ja" ? "話者" : "Spk "}
                        {speakerLabel(seg.speakerIdx)}
                      </span>
                    )}
                    {seg.text}
                  </div>
                );
              })}
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
