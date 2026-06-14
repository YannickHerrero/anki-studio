import type { FastifyInstance } from 'fastify';
import { getSession, requireSession, type Decision } from '../lib/session.js';
import { persistSession } from '../lib/persistence.js';

export async function sessionRoutes(app: FastifyInstance) {
  app.get('/session/:sid', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = getSession(sid);
    if (!session) return reply.code(404).send({ error: 'unknown session' });

    return {
      id: session.id,
      source: session.source,
      status: session.status,
      youtubeUrl: session.youtubeUrl,
      videoOriginalName: session.videoOriginalName,
      subtitleOriginalName: session.subtitleOriginalName,
      cueCount: session.cards.length,
      decisions: session.decisions,
      errorMessage: session.errorMessage,
    };
  });

  app.get('/session/:sid/cards', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = getSession(sid);
    if (!session) return reply.code(404).send({ error: 'unknown session' });

    return {
      source: session.source,
      cards: session.cards.map((c) => ({
        index: c.index,
        text: c.text,
        translation: c.translation,
        startMs: c.startMs,
        endMs: c.endMs,
        audioUrl: `/session/${sid}/media/audio/${c.index}?r=${c.rev}`,
        screenshotUrl: `/session/${sid}/media/image/${c.index}?r=${c.rev}`,
        audioReady: c.audioReady,
        screenshotReady: c.screenshotReady,
        rev: c.rev,
      })),
      decisions: session.decisions,
    };
  });

  app.post('/session/:sid/decisions', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);
    const body = req.body as { decisions?: Record<string, Decision> } | undefined;
    if (!body || typeof body.decisions !== 'object' || body.decisions === null) {
      return reply.code(400).send({ error: 'missing decisions' });
    }

    for (const [k, v] of Object.entries(body.decisions)) {
      const idx = Number(k);
      if (!Number.isInteger(idx)) continue;
      if (v === 'keep' || v === 'skip') {
        session.decisions[idx] = v;
      } else {
        delete session.decisions[idx];
      }
    }
    persistSession(session);
    return { ok: true, decisions: session.decisions };
  });
}
