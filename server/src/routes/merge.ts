import type { FastifyInstance } from 'fastify';
import { audioPath, requireSession, screenshotPath, type Card } from '../lib/session.js';
import { extractAudio, extractScreenshot } from '../lib/ffmpeg.js';
import { persistSession } from '../lib/persistence.js';

type MergeBody = {
  cardIndex?: number;
};

export async function mergeRoutes(app: FastifyInstance) {
  app.post('/session/:sid/merge', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as MergeBody | undefined) ?? {};
    const session = requireSession(sid);

    if (typeof body.cardIndex !== 'number') {
      return reply.code(400).send({ error: 'cardIndex is required' });
    }

    const pos = session.cards.findIndex((c) => c.index === body.cardIndex);
    if (pos < 0) return reply.code(404).send({ error: 'card not found' });
    if (pos === 0) return reply.code(400).send({ error: 'no previous card to merge with' });

    const prev = session.cards[pos - 1]!;
    const curr = session.cards[pos]!;

    const nextIndex = session.cards.reduce((m, c) => Math.max(m, c.index), -1) + 1;
    const sep = /[\s。．！？!?]$/.test(prev.text) ? '' : ' ';
    const mergedTranslation =
      prev.translation || curr.translation
        ? `${prev.translation ?? ''} ${curr.translation ?? ''}`.replace(/\s+/g, ' ').trim()
        : undefined;
    const merged: Card = {
      index: nextIndex,
      startMs: Math.min(prev.startMs, curr.startMs),
      endMs: Math.max(prev.endMs, curr.endMs),
      text: `${prev.text}${sep}${curr.text}`.trim(),
      translation: mergedTranslation,
      audioReady: false,
      screenshotReady: false,
      rev: 0,
    };

    await Promise.all([
      extractAudio(session.videoPath, audioPath(sid, merged.index), {
        startMs: merged.startMs,
        endMs: merged.endMs,
      }).then(() => {
        merged.audioReady = true;
      }),
      extractScreenshot(session.videoPath, screenshotPath(sid, merged.index), {
        startMs: merged.startMs,
        endMs: merged.endMs,
      }).then(() => {
        merged.screenshotReady = true;
      }),
    ]);

    session.cards.splice(pos - 1, 2, merged);
    delete session.decisions[prev.index];
    delete session.decisions[curr.index];
    persistSession(session, { immediate: true });

    return {
      mergedCardIndex: merged.index,
      newPosition: pos - 1,
      totalCards: session.cards.length,
    };
  });
}
