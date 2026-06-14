import type { FastifyInstance } from 'fastify';
import {
  allSessions,
  getSession,
  requireSession,
  type Decision,
} from '../lib/session.js';
import { deleteSession, persistSession } from '../lib/persistence.js';

function summarize(s: ReturnType<typeof allSessions>[number]) {
  const kept = Object.values(s.decisions).filter((d) => d === 'keep').length;
  const skipped = Object.values(s.decisions).filter((d) => d === 'skip').length;
  const exported = s.cards.filter(
    (c) => c.exported && s.decisions[c.index] === 'keep',
  ).length;
  return {
    id: s.id,
    source: s.source,
    title: s.title ?? s.videoOriginalName ?? s.youtubeUrl ?? '(untitled)',
    youtubeUrl: s.youtubeUrl,
    status: s.status,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    totalCards: s.cards.length,
    keptCount: kept,
    skippedCount: skipped,
    exportedCount: exported,
    pendingExportCount: kept - exported,
    hasExport: !!s.lastApkgPath,
  };
}

export async function sessionRoutes(app: FastifyInstance) {
  app.get('/sessions', async () => {
    const list = allSessions()
      .map(summarize)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { sessions: list };
  });

  app.delete('/session/:sid', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const s = getSession(sid);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    await deleteSession(sid);
    return { ok: true };
  });

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
        exported: !!c.exported,
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
