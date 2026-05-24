// Builds seed.json from real Project Gutenberg interior passages.
//
// Famous opening lines turn the game into a "do you recognize the classic?"
// test, so we pull MID-BOOK paragraphs from lesser-known public-domain works.
// Source text is fetched live via Gutendex (reliable ebook IDs + plain-text
// URLs), so the human side stays genuinely human-written and correctly cited.
//
//   node build-seed.js

import { writeFile } from 'node:fs/promises';

// Lesser-known (or at least not instantly-quotable) public-domain prose, varied
// in era/voice. `voice` becomes the generator's theme hint.
const WANT = [
  { author: 'George Gissing', title: 'New Grub Street', voice: 'a late-Victorian realist novel about literary London and money' },
  { author: 'Anthony Trollope', title: 'The Warden', voice: 'a quiet mid-Victorian novel of English clerical life' },
  { author: 'Elizabeth Gaskell', title: 'Wives and Daughters', voice: 'a Victorian provincial domestic novel' },
  { author: 'Sarah Orne Jewett', title: 'The Country of the Pointed Firs', voice: 'a quiet New England coastal regional sketch' },
  { author: 'William Dean Howells', title: 'The Rise of Silas Lapham', voice: 'a late-19th-century American realist novel of business and class' },
  { author: 'Frank Norris', title: 'McTeague', voice: 'a naturalist novel of 1890s San Francisco' },
  { author: 'Arnold Bennett', title: 'The Old Wives Tale', voice: 'an Edwardian English provincial novel of ordinary lives' },
  { author: 'Theodore Dreiser', title: 'Sister Carrie', voice: 'a turn-of-the-century American naturalist novel of the city' },
  { author: 'Edith Wharton', title: 'The House of Mirth', voice: 'an Edwardian New York society novel' },
  { author: 'Willa Cather', title: 'O Pioneers', voice: 'an early-20th-century prairie novel' },
  { author: 'Joseph Conrad', title: 'The Secret Agent', voice: 'an Edwardian novel of London streets and intrigue' },
  { author: 'Booth Tarkington', title: 'The Magnificent Ambersons', voice: 'an early-20th-century American family novel' },
  { author: 'George Eliot', title: 'Middlemarch', voice: 'a Victorian provincial novel of ideas and character' },
  { author: 'Thomas Hardy', title: 'The Return of the Native', voice: 'a Victorian novel of rural Wessex landscape and fate' },
  { author: 'Ivan Turgenev', title: 'Fathers and Sons', voice: 'a 19th-century Russian novel in English translation' },
  { author: 'Kate Chopin', title: 'The Awakening', voice: 'a turn-of-the-century American novel of interior awakening' },
  { author: 'Jack London', title: 'Martin Eden', voice: 'an early-20th-century American novel of ambition and self-education' },
  { author: 'Charlotte Perkins Gilman', title: 'Herland', voice: 'an early-20th-century utopian novel of observation' },
  { author: 'Stephen Crane', title: 'The Red Badge of Courage', voice: 'a Civil War novel in tense impressionist prose' },
  { author: 'Ford Madox Ford', title: 'The Good Soldier', voice: 'an early modernist novel of unreliable recollection' },
  { author: 'Olive Schreiner', title: 'The Story of an African Farm', voice: 'a late-Victorian novel of the South African veld' },
  { author: 'Gustave Flaubert', title: 'Sentimental Education', voice: 'a 19th-century French novel in English translation' },
];

const MIN_WORDS = 75;
const MAX_WORDS = 150;
const PER_BOOK = 2;

const wc = (s) => s.trim().split(/\s+/).length;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function findTextUrl(author, title) {
  const url = `https://gutendex.com/books?search=${encodeURIComponent(title + ' ' + author)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const book = (data.results || []).find((b) =>
    b.authors?.some((a) => a.name.toLowerCase().includes(author.split(' ').pop().toLowerCase())),
  ) || data.results?.[0];
  if (!book) return null;
  const fmt = book.formats || {};
  const key = Object.keys(fmt).find((k) => k.startsWith('text/plain') && !fmt[k].endsWith('.zip'));
  return key ? { textUrl: fmt[key], title: book.title, author: book.authors?.[0]?.name || author } : null;
}

function stripBoilerplate(raw) {
  let t = raw.replace(/\r\n/g, '\n');
  const start = t.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i);
  if (start !== -1) t = t.slice(t.indexOf('\n', start) + 1);
  const end = t.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i);
  if (end !== -1) t = t.slice(0, end);
  return t;
}

function extractParagraphs(text) {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/_/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return paras.filter((p) => {
    const words = wc(p);
    if (words < MIN_WORDS || words > MAX_WORDS) return false;
    if (/^(chapter|book|part|volume|canto|letter|section)\b/i.test(p)) return false;
    if (p === p.toUpperCase()) return false; // headings
    const quotes = (p.match(/["""]/g) || []).length;
    if (quotes > 2) return false; // skip heavy dialogue fragments
    if ((p.match(/[A-Za-z]/g) || []).length / p.length < 0.6) return false;
    if (/gutenberg|copyright|transcrib|footnote|\[/i.test(p)) return false;
    return true;
  });
}

const seeds = [];
for (const want of WANT) {
  try {
    const found = await findTextUrl(want.author, want.title);
    if (!found) { console.log(`skip (not found): ${want.title}`); continue; }
    const res = await fetch(found.textUrl);
    if (!res.ok) { console.log(`skip (fetch ${res.status}): ${want.title}`); continue; }
    const candidates = extractParagraphs(stripBoilerplate(await res.text()));
    if (candidates.length < 6) { console.log(`skip (few candidates ${candidates.length}): ${want.title}`); continue; }

    // Take interior paragraphs, spaced through the body, away from front/back matter.
    const lo = Math.floor(candidates.length * 0.25);
    const hi = Math.floor(candidates.length * 0.8);
    const span = hi - lo;
    for (let k = 0; k < PER_BOOK; k++) {
      const idx = lo + Math.floor((span * (k + 1)) / (PER_BOOK + 1));
      const text = candidates[idx];
      if (!text || seeds.some((s) => s.text === text)) continue;
      seeds.push({
        id: `${slug(want.title)}-${k}`,
        source: `${found.title.split(';')[0].split('\n')[0]} — ${want.author}, Project Gutenberg`,
        topic: want.voice,
        text,
      });
    }
    console.log(`ok: ${want.title} (+${PER_BOOK})`);
    await new Promise((r) => setTimeout(r, 1000)); // be polite
  } catch (err) {
    console.log(`error: ${want.title} — ${err.message}`);
  }
}

await writeFile(new URL('./seed.json', import.meta.url), JSON.stringify(seeds, null, 2));
console.log(`\nWrote seed.json with ${seeds.length} passages from ${new Set(seeds.map((s) => s.source)).size} works.`);
