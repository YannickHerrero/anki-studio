import type { FastifyInstance } from 'fastify';
import { audioPath, requireSession, screenshotPath, type Cue } from '../lib/session.js';
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
    if (session.videoRemoved) {
      return reply.code(409).send({ error: 'video removed — re-link it to merge' });
    }

    const pos = session.cues.findIndex((c) => c.index === body.cardIndex);
    if (pos < 0) return reply.code(404).send({ error: 'card not found' });
    if (pos === 0) return reply.code(400).send({ error: 'no previous card to merge with' });

    const prev = session.cues[pos - 1]!;
    const curr = session.cues[pos]!;

    const nextIndex = session.cues.reduce((m, c) => Math.max(m, c.index), -1) + 1;
    const sep = /[\s。．！？!?]$/.test(prev.text) ? '' : ' ';
    const mergedTranslation =
      prev.translation || curr.translation
        ? `${prev.translation ?? ''} ${curr.translation ?? ''}`.replace(/\s+/g, ' ').trim()
        : undefined;
    const merged: Cue = {
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
        audioTrackIndex: session.audioTrackIndex,
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

    session.cues.splice(pos - 1, 2, merged);
    if (session.decisions) {
      delete session.decisions[prev.index];
      delete session.decisions[curr.index];
    }
    // Picks made from either of the merged cues become picks of the new merged cue.
    for (const pick of session.picks) {
      if (pick.cueIndex === prev.index || pick.cueIndex === curr.index) {
        pick.cueIndex = merged.index;
      }
    }
    persistSession(session, { immediate: true });

    return {
      mergedCardIndex: merged.index,
      newPosition: pos - 1,
      totalCards: session.cues.length,
    };
  });
}
