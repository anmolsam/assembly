# Assembly — Live Sales Copilot Architecture

> The dream: a bot quietly joins **every** Beam AI client call, understands it live, and gives the AE a real-time copilot — grounded in every deal Beam ever won or lost — then routes the right human on Slack and writes the journey to HubSpot. **The human stays in power**: ambient capture, AE-controlled assist, never autopilot.

Assembly is **not** a from-scratch build. It is the **live, real-time front-end to brains Anmol already shipped** across his repos. This doc maps each layer to the existing code it reuses.

---

## The insight

Everything except live capture already exists:

| Capability | Already built in | Reuse |
|---|---|---|
| 9-question AI council (skeptic + optimist + chairman) | `beam-qualification-agent/src/council/runner.js` | lift `runCouncil()` |
| Closed-won / lost **deal bank** (win/loss DNA) | `beam-predictive-sales-agent` + `beam-qualification-agent/src/integrations/embeddings.js` (`findSimilarWins`) + `patterns.js` | lift pattern library + similarity |
| Live company intel (SERP / Exa / Firecrawl / Perplexity / ZoomInfo) | `icp-match/src/icp-final.js` | lift the enrichment pipeline |
| Pre-call brief synthesis | `beam-qualification-agent/src/coaching/copilot.js` | lift `generateCopilot()` |
| Slack routing | `orbit` (10 agents post to `#revops-team`) | lift the Slack client |
| Customer-journey stations | `orbit` (Stations 1–8) | Assembly = **Station 2 (Discovery), made live** |
| HubSpot deal read/write + field maps | `beam-qualification-agent/src/integrations/hubspot.js` | lift `AE_BANT_HS_FIELDS`, write to new `_as` fields |
| Forecasting | `forecasting-agent` | downstream consumer |

**New code Assembly actually writes:** the capture layer (Recall bot + desktop overlay), the AssemblyAI streaming bridge, the real-time turn→council loop, and the glue/orchestration. Everything else is integration.

---

## The seven layers

```
1 CAPTURE      Recall.ai bot (fleet, server-side)  ‖  Desktop overlay (per-rep, invisible)   [NEW]
2 TRANSPORT    real-time WS (live)                  ‖  final recording (post-call)
3 SPEECH       AssemblyAI Universal-Streaming u3-rt-pro (live)  ‖  Pre-recorded u3-pro (post) [NEW bridge]
4 INTELLIGENCE live BANT detector + live copilot LLM  ‖  9Q council (post-call authoritative) [REUSE council]
5 CONTEXT      HubSpot deal · Deal Bank (won/lost RAG) · live SERP/ICP intel · Beam playbook  [REUSE all]
6 SYNC & STORE HubSpot _as fields (live + final) · Airtable audit · transcript store           [REUSE hubspot.js]
7 EXPERIENCE   rep overlay (AE opt-in) · Slack auto-routing · manager dashboard · deal record  [REUSE orbit Slack]
```

### Layer 1 — Capture (the only real fork) — NEW
Two modes, one brain behind them:
- **Recall.ai bot** — calendar auto-joins external Google Meets, streams real-time audio/transcript + a final recording. Fleet-wide, zero install, visible participant. *Default for the rollout.* (Anmol supplies the Recall API key.)
- **Desktop overlay** — Cluely-style: taps system audio locally, renders an always-on-top overlay only the rep sees, no bot in the call. Lowest latency, invisible, per-rep install. *For reps who want the live whisper.*

Filter: only external calls (≥1 non-`attentive.ai` attendee).

### Layer 3 — Speech — NEW bridge
- Live: `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=u3-rt-pro&format_turns=true&token=…` — browser/desktop authenticates with a **server-minted short-lived token** (key never client-side). ~300ms turns. *(Working today in `live/`.)*
- Post-call: `POST /v2/transcript` with `speech_models:["universal-3-pro","universal-2"]`, `speaker_labels`, construction `keyterms_prompt`.

### Layer 4 — Intelligence — REUSE
- **Live (per finalized turn):** lightweight BANT detector + copilot LLM → "what to ask next." Latency budget keeps it <2s. *(Working today via Requesty LLM in `live/server.js`.)*
- **Post-call (authoritative):** `runCouncil(transcript, prevCtx, key, {rules, dealId})` — Claude skeptic + GPT optimist (parallel) → Gemini chairman. Overwrites the live estimate.

### Layer 5 — Context (what makes it unfair) — REUSE
- **Deal Bank:** at call start AND live, embed the running transcript → `findSimilarWins()` over closed-won/lost → surface "sounds like a deal you **won** (here's the play)" / "mirrors deals you **lost** (here's the trap)." Powered by `beam-predictive-sales-agent` DNA patterns.
- **Live intel:** `icp-match` pipeline (SERP + Exa + Firecrawl + Perplexity + ZoomInfo) enriches the prospect company mid-call.
- **HubSpot deal context + matching:** attendee email → contact → open deal in pipeline `676188492`.
- **Beam playbook:** supported trades, objection battlecards, competitor intel (Togal/Stack).

### Layer 6 — Sync & store — REUSE
- Live writes to **new `_as` (assembly-source) HubSpot fields** when council confidence ≥70 — **never** clobbers AE / `_ps` / `_cl` fields (honors the never-wipe rule).
- Final council verdict written on call close.
- Unmatched transcripts parked in Airtable; full audit log.

### Layer 7 — Experience — REUSE orbit Slack
- **Rep overlay** — BANT meter + coaching. **AE opt-in** — the bot is ambient, the assist is theirs.
- **Slack auto-routing** — trigger → person: competitor named → SE; $50k+ → manager; procurement blocker → RevOps; qualified → founder. Reuses orbit's Slack client.
- **Manager dashboard** + the **deal record** (verdict + transcript, during and after).

---

## The three "unfair advantage" capabilities

1. **Live deal-DNA match** — mid-call retrieval against every won/lost deal. The rep hears the winning move and the loss trap in real time.
2. **Pre-call simulation** — before the call, find the closest closed-won and generate a "this is how you win this one" walkthrough (objections + unlocking questions).
3. **Right human, right moment** — ambient bot in every call taps the right person on Slack the instant it matters.

No competitor combines live coaching + **live** HubSpot writeback + a Beam-specific council. (Cluely coaches live but barely touches CRM; Gong/Otter/Sybill write CRM only post-call.)

---

## Data flow — one turn, end to end (<2s)

1. Capture emits PCM16 16kHz frames (~0ms)
2. AssemblyAI finalizes the speaker-labeled turn (~300ms)
3. Brain scores BANT + deal-bank match + drafts coaching, context cached (~400ms)
4. Overlay updates; rep sees it (~100ms)
5. Confident answers (≥70%) write to HubSpot `_as` live (async)
6. On call end, full transcript runs the council for the authoritative verdict (post-call)

---

## Build order

- [x] Static architecture page (GitHub Pages) — explains the system
- [x] Working live demo (`live/`) — real AssemblyAI streaming + live BANT + LLM copilot, runs locally
- [ ] **Recall.ai backend** (needs Anmol's Recall key): calendar auto-join → real-time WS → live loop; final recording → council
- [ ] **Deal Bank service**: embed closed-won/lost (reuse predictive-agent + embeddings), live similarity endpoint
- [ ] **Live intel** endpoint (reuse icp-match)
- [ ] **HubSpot `_as` field creation** + live/final writes (reuse hubspot.js)
- [ ] **Slack routing** (reuse orbit Slack client) with trigger rules
- [ ] **Desktop overlay** prototype (Cluely-style, invisible) — phase 2
- [ ] **Pre-call simulation** generator

---

## Stack & security
- Node.js ESM + Express (matches every other repo).
- LLM via Requesty (council + copilot). STT via AssemblyAI.
- **Keys never in client code.** Browser/desktop gets a short-lived AssemblyAI token only. `.env` gitignored.
- ⚠️ Rotate the AssemblyAI key pasted in chat before production.
- Region: US (`api.assemblyai.com`, `na1` HubSpot).
