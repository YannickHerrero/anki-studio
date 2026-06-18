import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/session.js';
import { persistSession } from '../lib/persistence.js';

type EditCardBody = {
  text?: string;
  translation?: string;
  note?: string;
};

/**
 * Edit a single cue in place. Touches only the cue at the given index — used
 * by both manual edits in the review UI and edits applied from the subtitle chat.
 */
export async function editCardRoutes(app: FastifyInstance) {
  app.patch('/session/:sid/card/:index', async (req, reply) => {
    const { sid, index } = req.params as { sid: string; index: string };
    const idx = Number(index);
    if (!Number.isInteger(idx)) {
      return reply.code(400).send({ error: 'index must be an integer' });
    }

    const session = requireSession(sid);
    const cue = session.cues.find((c) => c.index === idx);
    if (!cue) return reply.code(404).send({ error: `no cue at index ${idx}` });

    const body = (req.body as EditCardBody | undefined) ?? {};
    if (
      body.text === undefined &&
      body.translation === undefined &&
      body.note === undefined
    ) {
      return reply.code(400).send({ error: 'nothing to update' });
    }

    if (typeof body.text === 'string' && body.text !== cue.text) {
      cue.text = body.text;
      // Refined tokens were tied to the old sentence — drop so /analysis
      // falls back to kuromoji until the user refines again.
      cue.refinedTokens = undefined;
    }
    if (typeof body.translation === 'string') cue.translation = body.translation;
    if (typeof body.note === 'string') cue.note = body.note;

    persistSession(session, { immediate: true });

    return {
      ok: true,
      card: {
        index: cue.index,
        text: cue.text,
        translation: cue.translation,
        note: cue.note,
      },
    };
  });
}
