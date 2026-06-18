import type { SubtitleCue } from './subtitles.js';
import type { WhisperWord } from './whisper.js';

/** Trigrams of a string after normalising whitespace and casing. */
export function trigrams(s: string): Set<string> {
  const cleaned = s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (cleaned.length === 0) return new Set();
  const padded = `  ${cleaned}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function visibleLength(s: string): number {
  return s.replace(/\s/g, '').length;
}

/**
 * For a single cue, find the contiguous range of Whisper words within
 * [searchStart, searchEnd) whose joined text has the highest trigram-Jaccard
 * similarity to the cue's text. Returns null if nothing scores above
 * `minScore` or the window is empty.
 */
export function alignCueToWords(
  cueText: string,
  words: WhisperWord[],
  searchStart: number,
  searchEnd: number,
  minScore: number,
): { startMs: number; endMs: number; score: number } | null {
  const cueTrigs = trigrams(cueText);
  const targetLen = visibleLength(cueText);
  if (cueTrigs.size === 0 || targetLen === 0) return null;
  if (searchStart >= searchEnd) return null;

  let best: { startMs: number; endMs: number; score: number } | null = null;

  for (let i = searchStart; i < searchEnd; i++) {
    let combined = '';
    for (let j = i; j < searchEnd; j++) {
      combined += words[j]!.word;
      const len = visibleLength(combined);
      if (len < targetLen * 0.5) continue;
      const score = jaccard(cueTrigs, trigrams(combined));
      if (!best || score > best.score) {
        best = {
          startMs: Math.max(0, Math.round(words[i]!.start * 1000)),
          endMs: Math.max(0, Math.round(words[j]!.end * 1000)),
          score,
        };
      }
      if (len > targetLen * 1.8) break;
    }
  }

  if (!best || best.score < minScore) return null;
  return best;
}

export type AlignmentResult = {
  cues: SubtitleCue[];
  aligned: number;
  skipped: number;
};

export type AlignmentOptions = {
  /** Half-window in ms around each cue's original start. Default 30s. */
  windowMs?: number;
  /** Minimum Jaccard score to accept a re-timing. Default 0.3. */
  minScore?: number;
};

/**
 * Walks the cue list in order, narrowing each cue's search window to start at
 * or after the previous cue's matched end. Cues that fall below `minScore`
 * keep their original timing and are reported as skipped.
 */
export function alignCues(
  cues: SubtitleCue[],
  words: WhisperWord[],
  opts: AlignmentOptions = {},
): AlignmentResult {
  const windowMs = opts.windowMs ?? 30_000;
  const minScore = opts.minScore ?? 0.3;

  if (words.length === 0 || cues.length === 0) {
    return { cues: [...cues], aligned: 0, skipped: cues.length };
  }

  // Helper: pick the smallest word index whose start >= ms.
  function firstWordAfter(ms: number): number {
    let lo = 0;
    let hi = words.length;
    const targetSec = ms / 1000;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (words[mid]!.start < targetSec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  let cursor = 0;
  let aligned = 0;
  let skipped = 0;
  const out: SubtitleCue[] = [];

  for (const cue of cues) {
    const expectedStart = firstWordAfter(cue.startMs - windowMs);
    const start = Math.max(cursor, expectedStart);
    const end = Math.min(words.length, firstWordAfter(cue.endMs + windowMs));

    const match = alignCueToWords(cue.text, words, start, Math.max(start + 1, end), minScore);

    if (match) {
      out.push({
        ...cue,
        startMs: match.startMs,
        endMs: Math.max(match.startMs + 1, match.endMs),
      });
      // Advance the cursor so the next cue starts from where this one matched.
      cursor = firstWordAfter(match.endMs);
      aligned++;
    } else {
      out.push({ ...cue });
      skipped++;
    }
  }

  return { cues: out, aligned, skipped };
}
