// Offline pool generator. Reads seed.json, asks Claude for N AI counterparts
// per human passage, and writes pool.json. Run locally with ANTHROPIC_API_KEY
// set; the result is committed and baked into the production image so the
// server never calls Claude at runtime.
//
//   ANTHROPIC_API_KEY=... node generate-pool.js [variantsPerSeed]

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = 'claude-sonnet-4-6';
const VARIANTS_PER_SEED = Number(process.argv[2]) || 5;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

const seed = JSON.parse(await readFile(path.join(__dirname, 'seed.json'), 'utf8'));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function wordCount(text) {
  return text.trim().split(/\s+/).length;
}

function sentenceCount(text) {
  const matches = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?/g);
  return matches ? matches.length : 1;
}

async function callClaude(humanSnippet, ceiling, avoid) {
  const targetWords = wordCount(humanSnippet.text);
  const targetSentences = sentenceCount(humanSnippet.text);
  const avoidNote = avoid.length
    ? `\n\nYou have already written these openings for this theme — do NOT repeat their phrasing or imagery, take a different angle:\n${avoid.map((a) => `- "${a.slice(0, 60)}…"`).join('\n')}`
    : '';

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: `Write an original literary passage on the given theme, in a similar voice, era, and register to the example. The passage should feel like it could appear in a different work by a different author of the same period.

LENGTH IS A HARD CONSTRAINT — your passage will be REJECTED if you exceed it:
- Word count: target ${targetWords}, absolute maximum ${ceiling}. Err shorter, never longer.
- Sentence count: target ${targetSentences}. This matters as much as word count — it controls density.
- Match the average sentence length of the example. If the example has short sentences, use short sentences.

Count words before you finish. If you are over the maximum, cut entire phrases until you are under.

Avoid AI tells: do not pack every sentence with ornate imagery; let some sentences be plain. Do not over-use em dashes. Do not use triadic "X, Y, and Z" lists where two items would do. Do not begin sentences with "Indeed" or "Yet" out of habit. Do not summarize the theme in a tidy closing sentence. Do not copy or paraphrase the example.

Theme: ${humanSnippet.topic}

Example for voice/era reference only (do not reuse phrases):
"""
${humanSnippet.text}
"""${avoidNote}

Output ONLY the passage itself. No preamble, no title, no quotation marks, no commentary.`,
      },
    ],
  });

  const block = message.content.find((c) => c.type === 'text');
  if (!block) throw new Error('No text in Anthropic response');
  return block.text.trim();
}

async function generateVariant(humanSnippet, avoid) {
  const ceiling = wordCount(humanSnippet.text) + 3;
  let attempt = await callClaude(humanSnippet, ceiling, avoid);
  if (wordCount(attempt) > ceiling) {
    attempt = await callClaude(humanSnippet, ceiling, avoid);
  }
  return attempt;
}

const pool = [];
let n = 0;
for (const snippet of seed) {
  const avoid = [];
  for (let v = 0; v < VARIANTS_PER_SEED; v++) {
    const aiText = await generateVariant(snippet, avoid);
    avoid.push(aiText);
    pool.push({
      id: `${snippet.id}-v${v}`,
      humanId: snippet.id,
      humanSource: snippet.source,
      humanText: snippet.text,
      aiText,
    });
    n++;
    process.stdout.write(`\rgenerated ${n}/${seed.length * VARIANTS_PER_SEED}`);
  }
}

await writeFile(path.join(__dirname, 'pool.json'), JSON.stringify(pool, null, 2));
console.log(`\nWrote pool.json with ${pool.length} rounds.`);
