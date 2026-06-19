import type { FastifyInstance } from 'fastify';
import { pickId, requireSession, type Pick } from '../lib/session.js';
import { persistSession } from '../lib/persistence.js';
import { loadKnown, saveKnown, type WordStatus } from '../lib/knownWords.js';

type AddBody = {
  cueIndex?: number;
  tokens?: Array<{
    surface?: string;
    lemma?: string;
    reading?: string;
  }>;
};

export async function pickRoutes(app: FastifyInstance) {
  app.get('/session/:sid/picks', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);
    return {
      picks: session.picks.map((p) => ({
        id: p.id,
        cueIndex: p.cueIndex,
        lemma: p.lemma,
        surface: p.surface,
        reading: p.reading,
        addedAt: p.addedAt,
        exported: !!p.exported,
      })),
    };
  });

  app.post('/session/:sid/pick', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as AddBody | undefined) ?? {};
    const session = requireSession(sid);

    if (typeof body.cueIndex !== 'number') {
      return reply.code(400).send({ error: 'cueIndex is required' });
    }
    const cue = session.cues.find((c) => c.index === body.cueIndex);
    if (!cue) return reply.code(404).send({ error: `no cue at index ${body.cueIndex}` });

    const incoming = Array.isArray(body.tokens) ? body.tokens : [];
    if (incoming.length === 0) {
      return reply.code(400).send({ error: 'tokens must be a non-empty array' });
    }

    const existing = new Set(session.picks.map((p) => p.id));
    const added: Pick[] = [];
    const now = Date.now();
    for (const t of incoming) {
      const lemma = (t.lemma ?? '').trim();
      const surface = (t.surface ?? lemma).trim();
      const reading = (t.reading ?? '').trim();
      if (!lemma) continue;
      const id = pickId(cue.index, lemma);
      if (existing.has(id)) continue;
      existing.add(id);
      const pick: Pick = {
        id,
        cueIndex: cue.index,
        lemma,
        surface: surface || lemma,
        reading,
        addedAt: now,
      };
      session.picks.push(pick);
      added.push(pick);
    }

    persistSession(session);

    // Tag freshly-picked lemmas as 'created' in the global known store so
    // future cues stop flagging them as new. Existing entries (Anki-derived
    // or manually marked known/ignored/learning) win — picks never downgrade.
    const statusChanges: Record<string, WordStatus> = {};
    if (added.length > 0) {
      const store = await loadKnown();
      let mutated = false;
      for (const p of added) {
        if (store.words[p.lemma]) continue;
        store.words[p.lemma] = {
          status: 'created',
          manual: true,
          reading: p.reading || undefined,
        };
        statusChanges[p.lemma] = 'created';
        mutated = true;
      }
      if (mutated) {
        store.updatedAt = Date.now();
        await saveKnown(store);
      }
    }

    return {
      addedCount: added.length,
      added: added.map((p) => ({ id: p.id, lemma: p.lemma, surface: p.surface })),
      pileCount: session.picks.length,
      statusChanges,
    };
  });

  app.delete('/session/:sid/pick/:pickId', async (req, reply) => {
    const { sid, pickId: id } = req.params as { sid: string; pickId: string };
    const session = requireSession(sid);
    const i = session.picks.findIndex((p) => p.id === id);
    if (i < 0) return reply.code(404).send({ error: 'unknown pick' });
    const [removed] = session.picks.splice(i, 1);
    persistSession(session);

    // Clear the 'created' tag we set on add — but only if no other pick on
    // this (or any) session still references the lemma, and only if the
    // entry is the one we set (manual + created). Anything else (known,
    // learning, Anki-sync derived) is left alone.
    const statusChanges: Record<string, WordStatus | null> = {};
    if (removed) {
      const stillPicked = session.picks.some((p) => p.lemma === removed.lemma);
      if (!stillPicked) {
        const store = await loadKnown();
        const entry = store.words[removed.lemma];
        if (entry?.status === 'created' && entry.manual) {
          delete store.words[removed.lemma];
          store.updatedAt = Date.now();
          await saveKnown(store);
          statusChanges[removed.lemma] = null;
        }
      }
    }

    return { ok: true, pileCount: session.picks.length, statusChanges };
  });
}
