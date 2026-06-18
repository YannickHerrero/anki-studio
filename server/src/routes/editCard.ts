import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/session.js';
import { persistSession } from '../lib/persistence.js';

type EditCardBody = {
  text?: string;
  translation?: string;
  note?: string;
};

/**
 * Edit a single card in place. Only the card (and its backing cue) at the given
 * index is ever touched — this is the single write path for both manual edits in
 * the review UI and edits applied from the subtitle chat.
 */
export async function editCardRoutes(app: FastifyInstance) {
  app.patch('/session/:sid/card/:index', async (req, reply) => {
    const { sid, index } = req.params as { sid: string; index: string };
    const idx = Number(index);
    if (!Number.isInteger(idx)) {
      return reply.code(400).send({ error: 'index must be an integer' });
    }

    const session = requireSession(sid);
    const card = session.cards.find((c) => c.index === idx);
    if (!card) return reply.code(404).send({ error: `no card at index ${idx}` });
    const cue = session.cues.find((c) => c.index === idx);

    const body = (req.body as EditCardBody | undefined) ?? {};
    if (
      body.text === undefined &&
      body.translation === undefined &&
      body.note === undefined
    ) {
      return reply.code(400).send({ error: 'nothing to update' });
    }

    if (typeof body.text === 'string') {
      card.text = body.text;
      if (cue) cue.text = body.text;
    }
    if (typeof body.translation === 'string') {
      card.translation = body.translation;
      if (cue) cue.translation = body.translation;
    }
    if (typeof body.note === 'string') {
      card.note = body.note;
      if (cue) cue.note = body.note;
    }

    persistSession(session, { immediate: true });

    return {
      ok: true,
      card: {
        index: card.index,
        text: card.text,
        translation: card.translation,
        note: card.note,
      },
    };
  });
}
