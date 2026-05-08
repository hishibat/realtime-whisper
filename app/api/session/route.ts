import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Lang = "ja" | "en";

function buildSession(language: Lang) {
  // Note: gpt-realtime-whisper rejects `turn_detection` — segmentation is
  // handled internally by the model. Only the speech-to-speech `gpt-realtime`
  // model accepts turn_detection.
  return {
    type: "transcription",
    audio: {
      input: {
        transcription: {
          model: "gpt-realtime-whisper",
          language,
        },
      },
    },
  } as const;
}

function extractEphemeralKey(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.value === "string") return d.value;
  const cs = d.client_secret as Record<string, unknown> | string | undefined;
  if (typeof cs === "string") return cs;
  if (cs && typeof cs === "object" && typeof cs.value === "string") return cs.value;
  return null;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not set on the server." },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const langParam = url.searchParams.get("language");
  const language: Lang = langParam === "en" ? "en" : "ja";

  const body = { session: buildSession(language) };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let r: Response;
  try {
    r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `OpenAI client_secrets fetch failed: ${msg}` },
      { status: 502 }
    );
  }
  clearTimeout(timer);

  const text = await r.text();
  if (!r.ok) {
    return NextResponse.json(
      { error: `OpenAI session error (${r.status}): ${text}` },
      { status: r.status }
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: `Unparseable OpenAI response: ${text.slice(0, 400)}` },
      { status: 502 }
    );
  }

  const clientSecret = extractEphemeralKey(data);
  if (!clientSecret) {
    return NextResponse.json(
      { error: "No ephemeral key found in OpenAI response." },
      { status: 502 }
    );
  }

  return NextResponse.json({ client_secret: clientSecret, language });
}
