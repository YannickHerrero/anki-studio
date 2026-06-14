import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';

const URL_RE = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?[^#]*\bv=[\w-]{11}|shorts\/[\w-]{11}|embed\/[\w-]{11})|youtu\.be\/[\w-]{11})/;

export function isValidYouTubeUrl(url: string): boolean {
  return URL_RE.test(url.trim());
}

export type ProbeResult = {
  title: string;
  durationMs: number;
};

export async function probe(url: string): Promise<ProbeResult> {
  const { stdout } = await execa(config.ytDlpPath, [
    '--no-playlist',
    '--skip-download',
    '--print', '%(title)s\t%(duration)s',
    url,
  ]);
  const [title, durationS] = stdout.trim().split('\t');
  const durationMs = Math.round(Number(durationS ?? 0) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('yt-dlp returned no duration');
  }
  return { title: title ?? 'YouTube video', durationMs };
}

export type DownloadOptions = {
  url: string;
  outDir: string;
  onProgress?: (pct: number) => void;
};

export type DownloadResult = {
  videoPath: string;
};

const PROGRESS_RE = /\[download\]\s+([\d.]+)%/;

export async function downloadVideo(opts: DownloadOptions): Promise<DownloadResult> {
  const outTemplate = path.join(opts.outDir, 'video.%(ext)s');
  const child = execa(config.ytDlpPath, [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '-f', 'bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outTemplate,
    opts.url,
  ]);

  if (opts.onProgress && child.stdout) {
    child.stdout.setEncoding('utf8');
    let buf = '';
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(PROGRESS_RE);
        if (m) opts.onProgress!(Math.min(100, Number(m[1])));
      }
    });
  }

  await child;

  const entries = await fs.readdir(opts.outDir);
  const candidate = entries.find((f) => f.startsWith('video.'));
  if (!candidate) throw new Error('yt-dlp finished but no video.* file was produced');
  return { videoPath: path.join(opts.outDir, candidate) };
}

export async function validateYtDlp(): Promise<void> {
  try {
    await execa(config.ytDlpPath, ['--version'], { stdout: 'ignore' });
  } catch (err) {
    throw new Error(
      `yt-dlp not found at "${config.ytDlpPath}". Install with: brew install yt-dlp`,
    );
  }
}
