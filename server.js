import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { recordServe, recordGuess, getStats, hashIp } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Pre-generated rounds, baked into the image. No Claude calls at runtime.
const pool = JSON.parse(await readFile(path.join(__dirname, 'pool.json'), 'utf8'));
if (!Array.isArray(pool) || pool.length === 0) {
  console.error('pool.json is empty — run `node generate-pool.js` first');
  process.exit(1);
}

// Ephemeral truth store: roundId -> { aiSide, poolId, servedAt }. Wiped on
// restart; analytics persist in SQLite, so losing this only abandons in-flight
// rounds.
const rounds = new Map();

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Client metadata from the Cloudflare edge (set on requests through the tunnel).
function client(req) {
  const ip = req.headers['cf-connecting-ip'] || req.ip || null;
  return {
    country: req.headers['cf-ipcountry'] || null,
    ua: (req.headers['user-agent'] || '').slice(0, 400) || null,
    ip_hash: hashIp(ip),
  };
}

const trunc = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

app.get('/healthz', (req, res) => res.json({ ok: true, pool: pool.length }));

app.get('/api/round', (req, res) => {
  const entry = pool[Math.floor(Math.random() * pool.length)];
  const aiSide = Math.random() < 0.5 ? 'A' : 'B';
  const roundId = crypto.randomUUID();
  rounds.set(roundId, { aiSide, poolId: entry.id, servedAt: Date.now() });

  const c = client(req);
  try {
    recordServe({
      ts: Date.now(),
      round_id: roundId,
      pool_id: entry.id,
      human_id: entry.humanId,
      ai_side: aiSide,
      session_id: trunc(req.query.s, 64),
      referrer: trunc(req.query.ref, 400),
      ...c,
    });
  } catch (err) {
    console.error('recordServe failed:', err.message);
  }

  res.json({
    roundId,
    textA: aiSide === 'A' ? entry.aiText : entry.humanText,
    textB: aiSide === 'A' ? entry.humanText : entry.aiText,
  });
});

app.post('/api/guess', (req, res) => {
  const { roundId, pick, sessionId, decideMs, sessionRoundN, viewportW } = req.body || {};
  const round = rounds.get(roundId);
  if (!round) return res.status(404).json({ error: 'Unknown round' });
  if (pick !== 'A' && pick !== 'B') return res.status(400).json({ error: 'pick must be A or B' });

  const entry = pool.find((p) => p.id === round.poolId);
  rounds.delete(roundId);
  const correct = pick === round.aiSide;

  const c = client(req);
  try {
    recordGuess({
      ts: Date.now(),
      round_id: roundId,
      pool_id: round.poolId,
      human_id: entry?.humanId ?? null,
      human_source: entry?.humanSource ?? null,
      ai_side: round.aiSide,
      pick,
      correct: correct ? 1 : 0,
      decide_ms: Number.isFinite(decideMs) ? Math.round(decideMs) : null,
      session_id: trunc(sessionId, 64),
      session_round_n: Number.isFinite(sessionRoundN) ? sessionRoundN : null,
      viewport_w: Number.isFinite(viewportW) ? viewportW : null,
      ...c,
    });
  } catch (err) {
    console.error('recordGuess failed:', err.message);
  }

  res.json({ correct, aiSide: round.aiSide, humanSource: entry?.humanSource ?? 'unknown' });
});

app.get('/api/stats', (req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    console.error('getStats failed:', err.message);
    res.status(500).json({ error: 'stats unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`Spot the AI listening on http://localhost:${PORT} (${pool.length} rounds)`);
});
