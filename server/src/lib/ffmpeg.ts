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

export type ScreenshotOptions = {
  startMs: number;
  endMs: number;
  width?: number;
  quality?: number;
};

export async function extractScreenshot(
  videoPath: string,
  outPath: string,
  opts: ScreenshotOptions,
): Promise<void> {
  const midMs = Math.round((opts.startMs + opts.endMs) / 2);
  const width = opts.width ?? 720;
  await execa(
    config.ffmpegPath,
    [
      '-y',
      '-loglevel', 'error',
      '-ss', msToSeconds(midMs),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-q:v', String(opts.quality ?? 4),
      outPath,
    ],
    { stdout: 'ignore' },
  );
}

export async function extractAudio(
  videoPath: string,
  outPath: string,
  opts: AudioOptions,
): Promise<void> {
  const prePad = opts.prePadMs ?? 500;
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
