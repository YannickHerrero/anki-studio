import fs from 'node:fs';
import path from 'node:path';
import { Agent, fetch, FormData } from 'undici';
import type { SubtitleCue } from './subtitles.js';

// Whisper transcription for a long audio can take several minutes; the
// default undici timeouts (5 min) silently kill the socket, surfacing as a
// useless "fetch failed". Allow up to 15 minutes for headers and body.
// We use undici's own fetch + Agent so the dispatcher API matches — passing an
// undici Agent to Node's bundled fetch hits a version mismatch
// (UND_ERR_INVALID_ARG: invalid onRequestStart method).
const dispatcher = new Agent({
  headersTimeout: 15 * 60 * 1000,
  bodyTimeout: 15 * 60 * 1000,
  connect: { timeout: 30 * 1000 },
});

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code || cause?.message) {
      return `${err.message} (${cause.code ?? ''}${cause.code && cause.message ? ': ' : ''}${cause.message ?? ''})`;
    }
    return err.message;
  }
  return String(err);
}

type WhisperWord = {
  word: string;
  start: number;
  end: number;
};

type WhisperSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
};

type VerboseJson = {
  language?: string;
  duration?: number;
  text?: string;
  segments?: WhisperSegment[];
  words?: WhisperWord[];
};

export type TranscribeOptions = {
  apiKey: string;
  audioPath: string;
  language?: string;
  /** Minimum word-gap (ms) treated as a sentence boundary. Default 400. */
  pauseThresholdMs?: number;
};

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

const SENTENCE_END_RE = /[。！？．!?]$/;

function cleanSegment(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

type Sentence = {
  startMs: number;
  endMs: number;
  text: string;
};

/**
 * Split a Whisper segment into one-sentence chunks using word-level timestamps.
 * Splits on (a) a word ending with Japanese/Western sentence-ending punctuation
 * or (b) a gap between consecutive words exceeding `pauseThresholdMs`.
 * Falls back to the original segment when no words array is present.
 */
function splitSegmentBySentence(
  seg: WhisperSegment,
  pauseThresholdMs: number,
): Sentence[] {
  const words = seg.words ?? [];
  if (words.length === 0) {
    const text = cleanSegment(seg.text ?? '');
    if (!text) return [];
    return [
      {
        startMs: Math.max(0, Math.round(seg.start * 1000)),
        endMs: Math.max(0, Math.round(seg.end * 1000)),
        text,
      },
    ];
  }

  const sentences: Sentence[] = [];
  let buf: WhisperWord[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    const text = cleanSegment(buf.map((w) => w.word).join(''));
    if (!text) {
      buf = [];
      return;
    }
    const startMs = Math.max(0, Math.round(buf[0]!.start * 1000));
    const endMs = Math.max(startMs + 1, Math.round(buf[buf.length - 1]!.end * 1000));
    sentences.push({ startMs, endMs, text });
    buf = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    buf.push(w);

    const next = words[i + 1];
    const gapMs = next ? Math.round((next.start - w.end) * 1000) : 0;
    const endsSentence = SENTENCE_END_RE.test(w.word.trim());
    const longPause = next ? gapMs >= pauseThresholdMs : false;

    if (endsSentence || longPause) flush();
  }
  flush();

  return sentences;
}

export async function transcribe(opts: TranscribeOptions): Promise<SubtitleCue[]> {
  const stat = await fs.promises.stat(opts.audioPath);
  if (stat.size > 25 * 1024 * 1024) {
    throw new Error(
      `audio is ${(stat.size / 1024 / 1024).toFixed(1)} MB — Whisper API limit is 25 MB. ` +
        'Pick a shorter video.',
    );
  }

  const buf = await fs.promises.readFile(opts.audioPath);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const blob = new Blob([u8], { type: 'audio/mpeg' });

  const form = new FormData();
  form.set('file', blob, path.basename(opts.audioPath));
  form.set('model', 'whisper-1');
  form.set('response_format', 'verbose_json');
  // Word-level timestamps let us split each Whisper segment into single
  // sentences ourselves — Whisper groups by acoustic chunks, not by grammar.
  form.set('timestamp_granularities[]', 'word');
  form.set('timestamp_granularities[]', 'segment');
  if (opts.language) form.set('language', opts.language);

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      dispatcher,
    });
  } catch (err) {
    throw new Error(
      `Whisper request failed: ${describeFetchError(err)}. ` +
        'The audio may be too long for a single call; try a shorter video.',
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`whisper ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as VerboseJson;
  const segments = json.segments ?? [];
  const pauseThresholdMs = opts.pauseThresholdMs ?? 400;

  const cues: SubtitleCue[] = [];
  let idx = 0;
  for (const seg of segments) {
    for (const s of splitSegmentBySentence(seg, pauseThresholdMs)) {
      cues.push({ index: idx++, startMs: s.startMs, endMs: s.endMs, text: s.text });
    }
  }
  return cues;
}
