# Realtime Whisper

Browser-based realtime speech-to-text powered by OpenAI's `gpt-realtime-whisper` model. Streams microphone audio over WebSocket and renders the transcript live. Works on desktop and mobile — anywhere with HTTPS and a microphone.

## Versions

| Route | Version | Notes |
|---|---|---|
| `/`   | **v1 (stable)** | Original simple transcript view |
| `/v2` | **v2 (enhanced)** | v1 + bullet formatting + heuristic speaker coloring + stop preserves in-flight text |

Each page links to the other from its header.

## Common features (v1 + v2)

- **Live transcript** with partial-token previews (gray) and finalized lines (white)
- **Language toggle** — Japanese / English
- **Copy all** — copies the full session transcript to clipboard
- **Resizable transcript area** — drag the bottom-right handle, or use A−/A+ to change font size
- **Mobile friendly** — single-page responsive layout
- **No audio is stored** on the app server. The Next.js API route only mints a short-lived ephemeral token; audio frames stream directly browser ⇄ OpenAI over WebSocket.

## v2-only features

- **Stop preserves text** — pressing Stop commits any in-flight partial to the final transcript (v1 discards it)
- **Format mode (整形)** — toggle prefixes each segment with `・` and inserts a blank line between, for readability
- **Speaker mode (話者)** — toggle that color-codes segments by inferred speaker. Uses a 1.5-second-pause heuristic to guess speaker changes (palette: white / sky-blue / pink). **Note: this is approximate, not real diarization** — true speaker identification needs a separate model (Deepgram, AssemblyAI, pyannote)
- **Copy honors current modes** — bullets and `[話者A]`-style labels are preserved in the copied text

## Architecture

```
Browser  ──── POST /api/session ────▶  Next.js (server)  ──── POST /v1/realtime/client_secrets ────▶  OpenAI
   │      (x-app-password header)           │   (verifies APP_PASSWORD; uses OPENAI_API_KEY)
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
cp .env.example .env.local         # fill in OPENAI_API_KEY and APP_PASSWORD
npm run dev
# open http://localhost:3000
```

Microphone permission requires either `localhost` or HTTPS — the dev server is fine.

## Access control (passphrase)

The deployed URL is reachable from the public internet, so `/api/session` is gated by a shared passphrase to prevent anonymous visitors from burning your OpenAI quota.

- Set `APP_PASSWORD` to a long random string (e.g. `openssl rand -base64 24`) once in Vercel **Project Settings → Environment Variables**, then redeploy. No CLI required.
- On first visit, each browser shows a setup screen asking for the passphrase and stores it in `localStorage` — used permanently on that device, no re-entry needed
- A wrong or missing passphrase makes `/api/session` return 401 and **OpenAI is never called** — no quota is consumed
- To revoke access, change `APP_PASSWORD` in Vercel and redeploy; every device will be forced to re-enter on next request

## Deploy to Vercel (one click)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhishibat%2Frealtime-whisper&env=OPENAI_API_KEY,APP_PASSWORD&envDescription=OPENAI_API_KEY%20%3D%20OpenAI%20key%20with%20gpt-realtime-whisper%20access.%20APP_PASSWORD%20%3D%20long%20random%20string%20gating%20%2Fapi%2Fsession.&project-name=realtime-whisper&repository-name=realtime-whisper)

After the deploy, set `OPENAI_API_KEY` **and** `APP_PASSWORD` in **Project Settings → Environment Variables** (the wizard asks for both during the clone). The deployed URL works on company laptops and mobile devices that allow microphone access on HTTPS.

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
