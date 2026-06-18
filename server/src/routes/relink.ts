import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { requireSession, sessionDir, type Session } from '../lib/session.js';
import { persistSession } from '../lib/persistence.js';
import { probeDurationMs } from '../lib/ffmpeg.js';

// A re-linked file is only useful if it lines up with the timing we cut against.
// Duration is the robust cross-source check (a YouTube re-download legitimately
// differs in byte size). We warn on mismatch but still allow it.
const DURATION_TOLERANCE_MS = 1000;

export function durationMismatch(session: Session, durationMs: number): boolean {
  if (!session.videoDurationMs || !durationMs) return false;
  return Math.abs(durationMs - session.videoDurationMs) > DURATION_TOLERANCE_MS;
}

export async function relinkRoutes(app: FastifyInstance) {
  // Upload-source re-link: the user re-picks the original file; we copy it back in.
  app.post('/session/:sid/relink', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);

    let outPath: string | null = null;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (part.fieldname !== 'video') {
        part.file.resume();
        continue;
      }
      const ext = path.extname(part.filename || '').toLowerCase().replace(/^\./, '') || 'mkv';
      outPath = path.join(sessionDir(sid), `video.${ext}`);
      await pipeline(part.file, fs.createWriteStream(outPath));
    }

    if (!outPath) {
      return reply.code(400).send({ error: '"video" file is required' });
    }

    const [stat, durationMs] = await Promise.all([fsp.stat(outPath), probeDurationMs(outPath)]);
    const mismatch = durationMismatch(session, durationMs);

    session.videoPath = outPath;
    session.videoSize = stat.size;
    session.videoRemoved = false;
    persistSession(session, { immediate: true });

    return {
      ok: true,
      mismatch,
      expectedDurationMs: session.videoDurationMs ?? null,
      actualDurationMs: durationMs,
    };
  });
}
