import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseSubs } from 'subsrt-ts';
import { parseAss } from './ass.js';

/**
 * Take a set of subtitle cues whose timings are in SOURCE-video time and
 * return the subset that falls within [startMs, endMs), with their timings
 * shifted to be relative to the chunk's start. Index is renumbered from 0.
 * Used when splitting a long upload into multiple chunk sessions.
 */
export function filterCuesToRange(
  cues: Array<{ index: number; startMs: number; endMs: number; text: string; translation?: string; note?: string }>,
  startMs: number,
  endMs: number,
): Array<{ index: number; startMs: number; endMs: number; text: string; translation?: string; note?: string }> {
  const out = [];
  let idx = 0;
  for (const c of cues) {
    // Include a cue if it starts before the chunk ends and ends after the
    // chunk starts — i.e. it overlaps the chunk's time range at all.
    if (c.startMs >= endMs) break;
    if (c.endMs <= startMs) continue;
    const s = Math.max(0, c.startMs - startMs);
    const e = Math.min(endMs, c.endMs) - startMs;
    if (e <= s) continue;
    out.push({
      index: idx++,
      startMs: s,
      endMs: e,
      text: c.text,
      translation: c.translation,
      note: c.note,
    });
  }
  return out;
}

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

// Music note glyphs commonly used to mark song/lyric lines in subtitles.
const MUSIC_PREFIX_RE = /^[♪♫♬♩🎵🎶#＃]/u;
// A line that is entirely a parenthetical, e.g. "(crowd noise)" or "（ざわめき）".
const FULLY_PARENTHESIZED_RE = /^[（(][^（()）]*[）)]$/u;

function cleanText(raw: string): string {
  return raw.replace(HTML_TAG_RE, '').replace(WHITESPACE_RE, ' ').trim();
}

/**
 * Lines that are never worth studying: song/lyric lines marked with a music note
 * and pure sound-effect / stage-direction lines wrapped entirely in parentheses
 * (e.g. opening themes, "(crowd making noise)", "（ため息）").
 */
export function isNonStudyLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (MUSIC_PREFIX_RE.test(t)) return true;
  if (FULLY_PARENTHESIZED_RE.test(t)) return true;
  return false;
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
      if (!text || isNonStudyLine(text)) continue;
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
    if (!text || isNonStudyLine(text)) continue;

    cues.push({ index: idx++, startMs, endMs, text });
  }
  return cues;
}
