import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/session.js';
import { persistSession } from '../lib/persistence.js';

/**
 * Delete a session's source video to free disk space. Everything needed for
 * review and export (per-card audio clips, screenshots, subtitles, translations,
 * notes) is kept — only the large source file is removed. Re-cutting tools
 * (retime / merge / align) stay unavailable until the video is re-linked.
 */
export async function storageRoutes(app: FastifyInstance) {
  app.post('/session/:sid/free-space', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);

    if (session.videoRemoved || !session.videoPath) {
      return { ok: true, freedBytes: 0, alreadyRemoved: true };
    }

    let freedBytes = 0;
    try {
      const stat = await fs.stat(session.videoPath);
      freedBytes = stat.size;
    } catch {
      // file already gone — fall through and just mark it removed
    }
    await fs.rm(session.videoPath, { force: true });

    session.videoRemoved = true;
    persistSession(session, { immediate: true });
    return { ok: true, freedBytes };
  });
}
