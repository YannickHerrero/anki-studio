import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { audioPath, requireSession, screenshotPath } from '../lib/session.js';

const MIME = {
  audio: 'audio/mpeg',
  image: 'image/jpeg',
} as const;

type Kind = keyof typeof MIME;

export async function mediaRoutes(app: FastifyInstance) {
  app.get('/session/:sid/media/:kind/:index', async (req, reply) => {
    const { sid, kind, index } = req.params as { sid: string; kind: string; index: string };
    if (kind !== 'audio' && kind !== 'image') {
      return reply.code(400).send({ error: 'invalid media kind' });
    }
    const k = kind as Kind;
    requireSession(sid);

    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) {
      return reply.code(400).send({ error: 'invalid index' });
    }

    const filePath = k === 'audio' ? audioPath(sid, i) : screenshotPath(sid, i);
    try {
      await fsp.access(filePath);
    } catch {
      return reply.code(404).send({ error: 'not ready' });
    }

    const stat = await fsp.stat(filePath);
    reply
      .header('Content-Type', MIME[k])
      .header('Content-Length', stat.size)
      .header('Cache-Control', 'no-store');
    return reply.send(fs.createReadStream(filePath));
  });
}
