# Realtime Whisper

Browser-based realtime speech-to-text powered by OpenAI's `gpt-realtime-whisper` model. Streams microphone audio over WebRTC and renders the transcript live. Works on desktop and mobile — anywhere with HTTPS and a microphone.

## Features

- **Live transcript** with partial-token previews (gray) and finalized lines (white)
- **Language toggle** — Japanese / English
- **Copy all** — copies the full session transcript to clipboard
- **Resizable transcript area** — drag the bottom-right handle, or use A−/A+ to change font size
- **Mobile friendly** — single-page responsive layout
- **No audio is stored** on the app server. The browser exchanges SDP through a Next.js API route only to fetch a short-lived ephemeral token; audio frames go directly browser ⇄ OpenAI over WebRTC.

## Architecture

```
Browser  ──── POST /api/session ────▶  Next.js (server)  ──── POST /v1/realtime/client_secrets ────▶  OpenAI
   │                                        │   (uses OPENAI_API_KEY)
   │◀──── ephemeral key ────────────────────┘
   │
   │ POST /v1/realtime/calls (SDP offer, Bearer ephemeral key)
   ├──────────────────────────────────────────────────────────────────────────────▶  OpenAI
   │◀── SDP answer ──────────────────────────────────────────────────────────────────
   │
   │ ──── Opus audio (RTP) ───────────────────────────────────────────────────────▶  OpenAI
   │◀──── transcription events (DataChannel JSON) ───────────────────────────────────
```

## Local development

Requires Node 20+.

```bash
npm install
cp .env.example .env.local         # fill in OPENAI_API_KEY
npm run dev
# open http://localhost:3000
```

Microphone permission requires either `localhost` or HTTPS — the dev server is fine.

## Deploy to Vercel (one click)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhishibat%2Frealtime-whisper&env=OPENAI_API_KEY&envDescription=OpenAI%20API%20key%20with%20access%20to%20gpt-realtime-whisper&project-name=realtime-whisper&repository-name=realtime-whisper)

After the deploy, set `OPENAI_API_KEY` in **Project Settings → Environment Variables** (the wizard asks for it during the clone). The deployed URL works on company laptops and mobile devices that allow microphone access on HTTPS.

## Tech

- Next.js 15 (App Router) + TypeScript
- WebRTC (no extra libs in the browser)
- OpenAI Realtime API — `gpt-realtime-whisper`, `server_vad` turn detection
- Server-issued ephemeral tokens (`/v1/realtime/client_secrets`) so the API key never reaches the browser

## Cost

`gpt-realtime-whisper` is billed at **$0.017 per minute of audio input** (as of 2026-05). A 30-min session ≈ $0.51.

## Roadmap

- Optional `semantic_vad` mode for sentence-aware segmentation
- File-upload mode (post-hoc transcription of recordings)
- Speaker diarization
- Saved sessions / sharable links

## License

MIT
