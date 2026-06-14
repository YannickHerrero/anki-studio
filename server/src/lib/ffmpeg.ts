import { execa } from 'execa';
import { config } from '../config.js';

export type AudioOptions = {
  startMs: number;
  endMs: number;
  prePadMs?: number;
  postPadMs?: number;
  bitrate?: string;
};

function msToSeconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

export async function extractAudio(
  videoPath: string,
  outPath: string,
  opts: AudioOptions,
): Promise<void> {
  const prePad = opts.prePadMs ?? 250;
  const postPad = opts.postPadMs ?? 500;
  const start = Math.max(0, opts.startMs - prePad);
  const end = opts.endMs + postPad;

  await execa(
    config.ffmpegPath,
    [
      '-y',
      '-loglevel', 'error',
      '-ss', msToSeconds(start),
      '-to', msToSeconds(end),
      '-i', videoPath,
      '-vn',
      '-ac', '2',
      '-c:a', 'libmp3lame',
      '-b:a', opts.bitrate ?? '96k',
      outPath,
    ],
    { stdout: 'ignore' },
  );
}
