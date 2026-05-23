import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Pre-generated rounds, baked into the image. No Claude calls at runtime.
const pool = JSON.parse(await readFile(path.join(__dirname, 'pool.json'), 'utf8'));
if (!Array.isArray(pool) || pool.length === 0) {
  console.error('pool.json is empty — run `node generate-pool.js` first');
  process.exit(1);
}

// Ephemeral truth store: roundId -> { aiSide, poolId }. Wiped on restart;
// scores live client-side, so losing this only abandons in-flight rounds.
const rounds = new Map();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true, pool: pool.length }));

app.get('/api/round', (req, res) => {
  const entry = pool[Math.floor(Math.random() * pool.length)];
  const aiSide = Math.random() < 0.5 ? 'A' : 'B';
  const roundId = crypto.randomUUID();
  rounds.set(roundId, { aiSide, poolId: entry.id });

  res.json({
    roundId,
    textA: aiSide === 'A' ? entry.aiText : entry.humanText,
    textB: aiSide === 'A' ? entry.humanText : entry.aiText,
  });
});

app.post('/api/guess', (req, res) => {
  const { roundId, pick } = req.body || {};
  const round = rounds.get(roundId);
  if (!round) return res.status(404).json({ error: 'Unknown round' });
  if (pick !== 'A' && pick !== 'B') return res.status(400).json({ error: 'pick must be A or B' });

  const entry = pool.find((p) => p.id === round.poolId);
  rounds.delete(roundId);

  res.json({
    correct: pick === round.aiSide,
    aiSide: round.aiSide,
    humanSource: entry?.humanSource ?? 'unknown',
  });
});

app.listen(PORT, () => {
  console.log(`Spot the AI listening on http://localhost:${PORT} (${pool.length} rounds)`);
});
