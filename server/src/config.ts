import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 5174),
  host: process.env.HOST ?? '127.0.0.1',
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  tmpDir: path.resolve(process.env.TMP_DIR ?? './tmp'),
};
