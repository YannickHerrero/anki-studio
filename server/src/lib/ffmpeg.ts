import { execa } from 'execa';
import { config } from '../config.js';

export type AudioOptions = {
  startMs: number;
  endMs: number;
  prePadMs?: number;
  postPadMs?: number;
  bitrate?: string;
  /** 0-based index among the file's audio streams. Defaults to 0. */
  audioTrackIndex?: number;
};

export type AudioStream = {
  index: number;
  codec: string;
  channels: number;
  language?: string;
  title?: string;
  isDefault: boolean;
};

const JAPANESE_LANGS = new Set(['jpn', 'ja', 'jap', 'japanese']);

export function pickJapaneseTrack(streams: AudioStream[]): number | null {
  if (streams.length === 0) return null;
  if (streams.length === 1) return 0;
  const jp = streams.filter((s) => s.language && JAPANESE_LANGS.has(s.language.toLowerCase()));
  if (jp.length === 1) return jp[0]!.index;
  // Multiple JP tracks or none — let the user pick.
  return null;
}

export async function probeAudioStreams(videoPath: string): Promise<AudioStream[]> {
  const { stdout } = await execa(config.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'a',
    videoPath,
  ]);
  type RawStream = {
    codec_name?: string;
    channels?: number;
    tags?: { language?: string; title?: string };
    disposition?: { default?: number };
  };
  const json = JSON.parse(stdout) as { streams?: RawStream[] };
  return (json.streams ?? []).map((s, i) => ({
    index: i,
    codec: s.codec_name ?? '',
    channels: s.channels ?? 0,
    language: s.tags?.language,
    title: s.tags?.title,
    isDefault: s.disposition?.default === 1,
  }));
}

export async function probeDurationMs(videoPath: string): Promise<number> {
  const { stdout } = await execa(config.ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    videoPath,
  ]);
  const seconds = Number(stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

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

export async function extractFullAudio(
  videoPath: string,
  outPath: string,
  audioTrackIndex = 0,
): Promise<void> {
  // Mono 16k MP3 keeps the file well under Whisper's 25 MB ceiling.
  await execa(
    config.ffmpegPath,
    [
      '-y',
      '-loglevel', 'error',
      '-i', videoPath,
      '-vn',
      '-map', `0:a:${audioTrackIndex}`,
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-b:a', '64k',
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
      '-map', `0:a:${opts.audioTrackIndex ?? 0}`,
      '-ac', '2',
      '-c:a', 'libmp3lame',
      '-b:a', opts.bitrate ?? '96k',
      outPath,
    ],
    { stdout: 'ignore' },
  );
}
