import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { createSession, sessionDir } from '../lib/session.js';
import { parseSubtitleFile } from '../lib/subtitles.js';

const SUBTITLE_EXTS = new Set(['srt', 'ass', 'ssa', 'vtt']);

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/upload', async (req, reply) => {
    const parts = req.parts();
    const session = await createSession();
    const dir = sessionDir(session.id);

    let gotVideo = false;
    let gotSubs = false;

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const filename = part.filename || 'unknown';
      const ext = path.extname(filename).toLowerCase().replace(/^\./, '');

      if (part.fieldname === 'video') {
        const outPath = path.join(dir, `video.${ext || 'mkv'}`);
        await pipeline(part.file, fs.createWriteStream(outPath));
        session.videoPath = outPath;
        session.videoOriginalName = filename;
        gotVideo = true;
      } else if (part.fieldname === 'subtitle') {
        if (!SUBTITLE_EXTS.has(ext)) {
          part.file.resume();
          return reply.code(400).send({ error: `unsupported subtitle format: ${ext}` });
        }
        const outPath = path.join(dir, `subs.${ext}`);
        await pipeline(part.file, fs.createWriteStream(outPath));
        session.subtitlePath = outPath;
        session.subtitleOriginalName = filename;
        gotSubs = true;
      } else {
        part.file.resume();
      }
    }

    if (!gotVideo || !gotSubs) {
      return reply.code(400).send({ error: 'both "video" and "subtitle" files are required' });
    }

    const cues = await parseSubtitleFile(session.subtitlePath);
    session.cues = cues;
    session.cards = cues.map((c) => ({ ...c, audioReady: false, screenshotReady: false }));

    return { sessionId: session.id, cueCount: cues.length };
  });
}
