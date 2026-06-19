import type { FastifyInstance } from 'fastify';
import {
  allSessions,
  getSession,
  requireSession,
} from '../lib/session.js';
import { deleteSession, persistSession } from '../lib/persistence.js';

function summarize(s: ReturnType<typeof allSessions>[number]) {
  const pickCount = s.picks.length;
  const exportedCount = s.picks.filter((p) => p.exported).length;
  return {
    id: s.id,
    source: s.source,
    title: s.title ?? s.videoOriginalName ?? s.youtubeUrl ?? '(untitled)',
    chunkIndex: s.chunkIndex,
    totalChunks: s.totalChunks,
    youtubeUrl: s.youtubeUrl,
    status: s.status,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    cueCount: s.cues.length,
    pileCount: pickCount,
    exportedCount,
    pendingExportCount: pickCount - exportedCount,
    hasExport: !!s.lastApkgPath,
    videoRemoved: !!s.videoRemoved,
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
      cueCount: session.cues.length,
      pileCount: session.picks.length,
      errorMessage: session.errorMessage,
    };
  });

  app.get('/session/:sid/cards', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = getSession(sid);
    if (!session) return reply.code(404).send({ error: 'unknown session' });

    return {
      source: session.source,
      videoRemoved: !!session.videoRemoved,
      cards: session.cues.map((c) => ({
        index: c.index,
        text: c.text,
        translation: c.translation,
        note: c.note,
        startMs: c.startMs,
        endMs: c.endMs,
        audioUrl: `/session/${sid}/media/audio/${c.index}?r=${c.rev}`,
        screenshotUrl: `/session/${sid}/media/image/${c.index}?r=${c.rev}`,
        audioReady: c.audioReady,
        screenshotReady: c.screenshotReady,
        rev: c.rev,
      })),
    };
  });

  app.post('/session/:sid/audioTrack', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);
    const body = req.body as { audioTrackIndex?: number } | undefined;
    if (!body || typeof body.audioTrackIndex !== 'number') {
      return reply.code(400).send({ error: 'audioTrackIndex is required' });
    }
    const tracks = session.audioStreams ?? [];
    if (body.audioTrackIndex < 0 || (tracks.length > 0 && body.audioTrackIndex >= tracks.length)) {
      return reply.code(400).send({ error: 'audioTrackIndex out of range' });
    }
    session.audioTrackIndex = body.audioTrackIndex;
    persistSession(session, { immediate: true });
    return { ok: true, audioTrackIndex: session.audioTrackIndex };
  });
}
