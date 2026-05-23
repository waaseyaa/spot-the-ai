import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'spot-the-ai.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// IP-hashing salt: auto-generated and kept only in the data volume so hashes
// are non-reversible (IPv4 is small enough to brute-force an unsalted hash)
// without introducing a managed secret. Raw IPs are never stored.
const saltPath = path.join(DATA_DIR, '.ip_salt');
let IP_SALT;
if (existsSync(saltPath)) {
  IP_SALT = readFileSync(saltPath, 'utf8').trim();
} else {
  IP_SALT = crypto.randomBytes(32).toString('hex');
  writeFileSync(saltPath, IP_SALT, { mode: 0o600 });
}

db.exec(`
CREATE TABLE IF NOT EXISTS serves (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  ai_side TEXT NOT NULL,
  session_id TEXT,
  country TEXT,
  ua TEXT,
  ip_hash TEXT,
  referrer TEXT
);
CREATE TABLE IF NOT EXISTS guesses (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  human_source TEXT,
  ai_side TEXT NOT NULL,
  pick TEXT NOT NULL,
  correct INTEGER NOT NULL,
  decide_ms INTEGER,
  session_id TEXT,
  session_round_n INTEGER,
  country TEXT,
  ua TEXT,
  ip_hash TEXT,
  viewport_w INTEGER
);
CREATE INDEX IF NOT EXISTS idx_guesses_pool ON guesses(pool_id);
CREATE INDEX IF NOT EXISTS idx_guesses_ts ON guesses(ts);
CREATE INDEX IF NOT EXISTS idx_guesses_session ON guesses(session_id);
`);

export function hashIp(ip) {
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${IP_SALT}|${day}|${ip}`).digest('hex').slice(0, 16);
}

const insertServe = db.prepare(`
  INSERT INTO serves (ts, round_id, pool_id, human_id, ai_side, session_id, country, ua, ip_hash, referrer)
  VALUES (@ts, @round_id, @pool_id, @human_id, @ai_side, @session_id, @country, @ua, @ip_hash, @referrer)
`);

const insertGuess = db.prepare(`
  INSERT INTO guesses (ts, round_id, pool_id, human_id, human_source, ai_side, pick, correct,
                       decide_ms, session_id, session_round_n, country, ua, ip_hash, viewport_w)
  VALUES (@ts, @round_id, @pool_id, @human_id, @human_source, @ai_side, @pick, @correct,
          @decide_ms, @session_id, @session_round_n, @country, @ua, @ip_hash, @viewport_w)
`);

export const recordServe = (row) => insertServe.run(row);
export const recordGuess = (row) => insertGuess.run(row);

const startOfTodayMs = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export function getStats() {
  const overall = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(correct),0) c, AVG(decide_ms) avg_ms FROM guesses').get();
  const sessions = db.prepare('SELECT COUNT(DISTINCT session_id) n FROM guesses WHERE session_id IS NOT NULL').get().n;
  const servesTotal = db.prepare('SELECT COUNT(*) n FROM serves').get().n;
  const uniqToday = db.prepare('SELECT COUNT(DISTINCT ip_hash) n FROM guesses WHERE ip_hash IS NOT NULL AND ts >= ?').get(startOfTodayMs()).n;

  const hardest = db.prepare(`
    SELECT pool_id, human_source, COUNT(*) plays, SUM(correct) correct,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) accuracy
    FROM guesses GROUP BY pool_id HAVING plays >= 5
    ORDER BY accuracy ASC LIMIT 10
  `).all();

  const bySeed = db.prepare(`
    SELECT human_id, COUNT(*) plays, ROUND(100.0 * SUM(correct) / COUNT(*), 1) accuracy
    FROM guesses GROUP BY human_id HAVING plays >= 3 ORDER BY accuracy ASC
  `).all();

  const byDay = db.prepare(`
    SELECT date(ts/1000, 'unixepoch') day, COUNT(*) plays,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) accuracy
    FROM guesses GROUP BY day ORDER BY day DESC LIMIT 14
  `).all();

  const byCountry = db.prepare(`
    SELECT COALESCE(country,'??') country, COUNT(*) plays,
           ROUND(100.0 * SUM(correct) / COUNT(*), 1) accuracy
    FROM guesses GROUP BY country ORDER BY plays DESC LIMIT 10
  `).all();

  return {
    total_guesses: overall.n,
    total_correct: overall.c,
    accuracy: overall.n ? Math.round((overall.c / overall.n) * 1000) / 10 : 0,
    avg_decide_ms: overall.avg_ms ? Math.round(overall.avg_ms) : null,
    unique_sessions: sessions,
    unique_visitors_today: uniqToday,
    rounds_served: servesTotal,
    abandoned_estimate: Math.max(0, servesTotal - overall.n),
    hardest_passages: hardest,
    by_seed: bySeed,
    by_day: byDay,
    by_country: byCountry,
  };
}
