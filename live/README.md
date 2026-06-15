# Assembly — Live Sales Copilot (local demo)

Talk into your mic → **live AssemblyAI transcription** → **real-time BANT scoring** (9 Beam questions) → **live "what to ask next" copilot**.

The architecture page (https://anmolsam.github.io/assembly/) is the static explainer.
This `live/` folder is the **working prototype** — it must run locally because it holds the API key.

## Why local (not GitHub Pages)
A browser must never hold the AssemblyAI key (anyone could steal it from page source).
So a tiny Node server holds the key and mints a **short-lived streaming token** for the browser.
This is exactly how Cluely/Otter/etc. do it. GitHub Pages can only serve static files, so the live demo can't run there.

## Run it
```bash
cd /Users/anmol/assembly
# .env already has ASSEMBLYAI_API_KEY (gitignored)
node live/server.js
# open http://localhost:4242  → click "Start listening" → allow mic → talk
```

Try saying: *"We're a commercial drywall sub and we'd love to offload our takeoffs to AI. Ten k is fine, I've got budget this quarter, and I'm the VP so it's my call."*

## Brain
- **Transcription:** AssemblyAI Universal-Streaming (`u3-rt-pro`), browser temp-token auth.
- **Copilot:** an LLM via `REQUESTY_API_KEY` or `OPENROUTER_API_KEY` if set; otherwise a built-in heuristic so it still works with zero extra keys.

## Files
- `server.js` — token mint (`/api/token`) + copilot brain (`/api/copilot`)
- `live.html` — mic capture (AudioWorklet → PCM16 16kHz) + WebSocket to AssemblyAI + live UI
