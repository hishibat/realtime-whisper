"use client";

import { useEffect, useState, useCallback, FormEvent } from "react";
import {
  getAppPassword,
  setAppPassword,
  PASSWORD_REJECTED_EVENT,
} from "@/lib/auth";

type Phase = "checking" | "needs-password" | "ready";

export default function PasswordGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const stored = getAppPassword();
    setPhase(stored ? "ready" : "needs-password");
  }, []);

  useEffect(() => {
    function onRejected() {
      setError("パスフレーズが正しくありません。再入力してください。");
      setInput("");
      setPhase("needs-password");
    }
    window.addEventListener(PASSWORD_REJECTED_EVENT, onRejected);
    return () => window.removeEventListener(PASSWORD_REJECTED_EVENT, onRejected);
  }, []);

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed) {
        setError("パスフレーズを入力してください。");
        return;
      }
      setSubmitting(true);
      setError(null);
      setAppPassword(trimmed);
      setInput("");
      setPhase("ready");
      setSubmitting(false);
    },
    [input]
  );

  if (phase === "checking") {
    return (
      <main>
        <div className="gate-loading">Loading…</div>
      </main>
    );
  }

  if (phase === "needs-password") {
    return (
      <main>
        <div className="gate-card">
          <h1 className="gate-title">パスフレーズを設定してください</h1>
          <p className="gate-desc">
            このアプリは管理者が設定したパスフレーズを知っているユーザのみ利用できます。
            <br />
            一度入力すれば、このブラウザでは恒久的に保存され、次回以降は自動的にログインします。
          </p>
          <form onSubmit={onSubmit} className="gate-form">
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="passphrase"
              autoFocus
              autoComplete="current-password"
              spellCheck={false}
              className="gate-input"
              disabled={submitting}
            />
            <button
              type="submit"
              className="gate-submit"
              disabled={submitting || !input.trim()}
            >
              保存して開始
            </button>
          </form>
          {error && <p className="gate-error">{error}</p>}
          <p className="gate-hint">
            パスフレーズが分からない場合は管理者に問い合わせてください。
          </p>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}
