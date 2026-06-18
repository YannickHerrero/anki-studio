import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseSubs } from 'subsrt-ts';
import { parseAss } from './ass.js';

export type SubtitleCue = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  translation?: string;
  /** Freeform learner note, shown on the card back and editable in review. */
  note?: string;
};

const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

function cleanText(raw: string): string {
  return raw.replace(HTML_TAG_RE, '').replace(WHITESPACE_RE, ' ').trim();
}

export async function parseSubtitleFile(filePath: string): Promise<SubtitleCue[]> {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  const raw = await fs.readFile(filePath, 'utf8');

  if (ext === 'ass' || ext === 'ssa') {
    // subsrt-ts mishandles ASS (drops the opening `{` of override tags, and eats
    // the first character of plain dialogue). Use our own parser.
    const cues: SubtitleCue[] = [];
    let idx = 0;
    for (const c of parseAss(raw)) {
      const text = cleanText(c.text);
      if (!text) continue;
      cues.push({ index: idx++, startMs: c.startMs, endMs: c.endMs, text });
    }
    return cues;
  }

  const captions = parseSubs(raw, { format: ext });
  const cues: SubtitleCue[] = [];
  let idx = 0;
  for (const cap of captions) {
    if (cap.type !== 'caption') continue;
    const startMs = typeof cap.start === 'number' ? cap.start : 0;
    const endMs = typeof cap.end === 'number' ? cap.end : 0;
    if (endMs <= startMs) continue;

    const text = cleanText(cap.text ?? '');
    if (!text) continue;

    cues.push({ index: idx++, startMs, endMs, text });
  }
  return cues;
}
