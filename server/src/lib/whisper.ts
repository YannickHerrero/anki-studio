import fs from 'node:fs';
import path from 'node:path';
import type { SubtitleCue } from './subtitles.js';

type WhisperSegment = {
  id: number;
  start: number;
  end: number;
  text: string;
};

type VerboseJson = {
  language?: string;
  duration?: number;
  text?: string;
  segments?: WhisperSegment[];
};

export type TranscribeOptions = {
  apiKey: string;
  audioPath: string;
  language?: string;
};

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

function cleanSegment(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
  form.append('file', blob, path.basename(opts.audioPath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  if (opts.language) form.append('language', opts.language);

  const res = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`whisper ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as VerboseJson;
  const segments = json.segments ?? [];

  const cues: SubtitleCue[] = [];
  let idx = 0;
  for (const seg of segments) {
    const text = cleanSegment(seg.text ?? '');
    if (!text) continue;
    const startMs = Math.max(0, Math.round(seg.start * 1000));
    const endMs = Math.max(startMs + 1, Math.round(seg.end * 1000));
    cues.push({ index: idx++, startMs, endMs, text });
  }
  return cues;
}
