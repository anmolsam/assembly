// Assembly — local live demo server (ESM, zero deps).
// Holds the AssemblyAI key, mints short-lived streaming tokens for the browser,
// and runs the live BANT + copilot "brain" (LLM if a key is present, heuristic otherwise).
//
//   node live/server.js   ->   http://localhost:4242
//
// SECURITY: the raw API key NEVER reaches the browser. The browser only ever
// receives a single-use streaming token (expires in seconds).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}

const __dir = dirname(fileURLToPath(import.meta.url));
const KEY  = process.env.ASSEMBLYAI_API_KEY;
const PORT = process.env.PORT || 4242;

// Optional LLM brain. Works with Requesty or OpenRouter (OpenAI-compatible).
const LLM = (() => {
  if (process.env.REQUESTY_API_KEY)  return { url: 'https://router.requesty.ai/v1/chat/completions', key: process.env.REQUESTY_API_KEY,  model: 'anthropic/claude-haiku-4-5-20251001' };
  if (process.env.OPENROUTER_API_KEY) return { url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY, model: 'anthropic/claude-3.5-haiku' };
  return null;
})();

if (!KEY) { console.error('Missing ASSEMBLYAI_API_KEY in .env'); process.exit(1); }

// ---------- the 9 BANT questions (mirrors beam-qualification-agent AE_BANT_HS_FIELDS) ----------
const BANT = [
  { id: 'trade_supported',      cat: 'N', q: 'Is the trade/service supported by Beam AI?' },
  { id: 'offload_willing',      cat: 'N', q: 'Is the customer willing to offload end-to-end takeoffs to AI?' },
  { id: 'tat_aligned',          cat: 'N', q: 'Does the required turnaround time align with Beam delivery?' },
  { id: 'investment_confirmed', cat: 'B', q: 'Has the ability to invest (~$10k DFY) been confirmed?' },
  { id: 'decision_criteria',    cat: 'A', q: 'Is there a confirmed champion / decision-maker?' },
  { id: 'approval_steps',       cat: 'A', q: 'Are internal approval steps (procurement/legal) mapped?' },
  { id: 'close_90_days',        cat: 'T', q: 'Can the deal close within 90 days?' },
  { id: 'deal_size_50k',        cat: 'T', q: 'If longer than 90 days, is deal size > $50k?' },
  { id: 'pilot_300_confirmed',  cat: 'B', q: 'Is the $300 paid pilot confirmed?' },
];

// ---------- heuristic detector (fallback brain, runs with zero extra keys) ----------
const HINTS = {
  trade_supported:      [/\b(drywall|roofing|roofer|electrical|framing|lumber|concrete|rebar|plumbing|flooring|insulation|painting|demolition|utilities|earthwork|gc|general contractor|sub(contractor)?)\b/i],
  offload_willing:      [/\b(offload|hand (it|that) off|let (the )?ai|automate (our )?takeoff|willing to|open to|move away from doing)\b/i],
  tat_aligned:          [/\b(turn ?around|24 ?hour|48 ?hour|two days|2 days|same day|tat|bids? back)\b/i],
  investment_confirmed: [/\b(budget|10 ?k|\$10|invest|afford|signed off|set aside|tooling budget)\b/i],
  decision_criteria:    [/\b(my call|i decide|i'?m the|decision[- ]maker|champion|vp of|owner|i sign|head of)\b/i],
  approval_steps:       [/\b(procurement|legal|msa|approval|sign[- ]?off|contract review|paperwork)\b/i],
  close_90_days:        [/\b(90 days|this quarter|next month|by (end of )?(q[1-4]|the quarter)|sign (soon|this)|move (fast|now))\b/i],
  deal_size_50k:        [/\b(50 ?k|\$50|six figure|enterprise|large (deal|account))\b/i],
  pilot_300_confirmed:  [/\b(300|\$300|paid pilot|do the pilot|start the pilot)\b/i],
};
const COACH = {
  trade_supported:      'Confirm their exact trade — make sure it is on the supported list before going deep.',
  offload_willing:      'Probe: would they hand the full takeoff to AI, or just assist their estimators?',
  tat_aligned:          'Ask what turnaround they need on bids — anchor against our 24–48h.',
  investment_confirmed: 'Surface budget: "What have you set aside for estimating tools this quarter?"',
  decision_criteria:    'Find the champion: "Who else signs off on a tool like this?"',
  approval_steps:       'Map the process: "Once you decide, any procurement or legal steps?"',
  close_90_days:        'Test timeline: "If the pilot lands, could you sign within the quarter?"',
  deal_size_50k:        'If timeline slips past 90 days, qualify deal size (>$50k).',
  pilot_300_confirmed:  'Close the next step: "Shall we lock the $300 paid pilot to prove it out?"',
};

function heuristicBant(text) {
  const out = {};
  for (const { id } of BANT) out[id] = HINTS[id].some(re => re.test(text)) ? 'yes' : 'unknown';
  return out;
}
function buildSuggestion(bant) {
  const missing = BANT.filter(b => bant[b.id] !== 'yes');
  const confirmed = BANT.length - missing.length;
  if (!missing.length) return { suggestion: 'All 9 confirmed — move to close the $300 pilot and set the kickoff date.', missing: [], confirmed };
  // suggest the next most valuable missing item (mandatory N/B first)
  const order = ['trade_supported','offload_willing','tat_aligned','investment_confirmed','decision_criteria','close_90_days','approval_steps','pilot_300_confirmed','deal_size_50k'];
  const next = order.find(id => bant[id] !== 'yes');
  return { suggestion: COACH[next], missing: missing.map(m => m.id), confirmed };
}

async function llmBant(transcript) {
  if (!LLM) return null;
  const sys = `You are a live sales copilot for Beam AI (construction takeoff AI). From the running call transcript, judge each of these 9 BANT questions as "yes", "no", or "unknown" based ONLY on what was actually said. Then give ONE short live coaching line (max 18 words) telling the rep what to ask or say NEXT to advance the deal. Questions:\n${BANT.map(b => `- ${b.id}: ${b.q}`).join('\n')}\nReturn STRICT JSON: {"bant":{"<id>":"yes|no|unknown",...all 9...},"suggestion":"...","reason":"..."}`;
  try {
    const res = await fetch(LLM.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LLM.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM.model, max_tokens: 500, temperature: 0,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: transcript.slice(-4000) }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = j.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    const confirmed = BANT.filter(b => parsed.bant?.[b.id] === 'yes').length;
    return { bant: parsed.bant, suggestion: parsed.suggestion, confirmed, source: 'llm' };
  } catch { return null; }
}

// ---------- http ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/live.html') {
    try {
      const html = await readFile(join(__dir, 'live.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html);
    } catch { res.writeHead(404); return res.end('live.html not found'); }
  }

  if (url.pathname === '/api/token') {
    try {
      const r = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=300', { headers: { Authorization: KEY } });
      const j = await r.json();
      res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(j));
    } catch (e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
  }

  if (url.pathname === '/api/copilot' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let transcript = '';
      try { transcript = JSON.parse(body).transcript || ''; } catch {}
      let result = await llmBant(transcript);
      if (!result) { const bant = heuristicBant(transcript); result = { bant, ...buildSuggestion(bant), source: 'heuristic' }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  ⚡ Assembly live demo  →  http://localhost:${PORT}`);
  console.log(`  STT: AssemblyAI Universal-Streaming (live token mint)`);
  console.log(`  Copilot brain: ${LLM ? `LLM (${LLM.model})` : 'heuristic (no valid LLM key found — set REQUESTY_API_KEY or OPENROUTER_API_KEY for the real brain)'}\n`);
});
