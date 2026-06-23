import type { FastifyInstance } from 'fastify';
import { requireSession, type RefinedToken } from '../lib/session.js';
import { persistSession } from '../lib/persistence.js';
import { tokenize } from '../lib/tokenizer.js';
import { stripFurigana } from '../lib/furigana.js';

type EditCardBody = {
  text?: string;
  translation?: string;
  note?: string;
};

type MergeTokensBody = {
  /** Inclusive token-index span (in /analysis order) to merge into one token. */
  from?: number;
  to?: number;
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

  /**
   * Merge an adjacent span of tokens into a single token (e.g. 実用 + 性 →
   * 実用性). Materializes the cue's current tokenization (refined if present,
   * else kuromoji — the same list /analysis renders, so the indices line up),
   * collapses [from, to] into one content token, and persists it as
   * refinedTokens. The merged surface concatenation equals the originals, so
   * the tokens-cover-the-sentence invariant holds.
   */
  app.post('/session/:sid/card/:index/mergeTokens', async (req, reply) => {
    const { sid, index } = req.params as { sid: string; index: string };
    const idx = Number(index);
    if (!Number.isInteger(idx)) {
      return reply.code(400).send({ error: 'index must be an integer' });
    }

    const session = requireSession(sid);
    const cue = session.cues.find((c) => c.index === idx);
    if (!cue) return reply.code(404).send({ error: `no cue at index ${idx}` });

    const { from, to } = (req.body as MergeTokensBody | undefined) ?? {};
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return reply.code(400).send({ error: 'from and to must be integers' });
    }

    const current: RefinedToken[] = cue.refinedTokens
      ? cue.refinedTokens
      : (await tokenize(stripFurigana(cue.text))).map((t) => ({
          surface: t.surface,
          lemma: t.lemma,
          reading: t.reading,
          content: t.content,
        }));

    const lo = Math.min(from!, to!);
    const hi = Math.max(from!, to!);
    if (lo < 0 || hi >= current.length || hi <= lo) {
      return reply
        .code(400)
        .send({ error: 'from/to out of range or do not span at least two tokens' });
    }

    const span = current.slice(lo, hi + 1);
    const merged: RefinedToken = {
      surface: span.map((t) => t.surface).join(''),
      // A merged compound's dictionary form is its surface (実用 + 性 → 実用性).
      lemma: span.map((t) => t.surface).join(''),
      reading: span.map((t) => t.reading).join(''),
      // The user merged these on purpose to pick them as one vocab word.
      content: true,
    };

    cue.refinedTokens = [...current.slice(0, lo), merged, ...current.slice(hi + 1)];
    persistSession(session, { immediate: true });

    return { ok: true, tokens: cue.refinedTokens };
  });
}
