import type { FastifyInstance } from 'fastify';
import {
  loadKnown,
  saveKnown,
  summarize,
  type KnownEntry,
  type KnownStore,
  type WordStatus,
} from '../lib/knownWords.js';
import { buildKnownFromAnki } from '../lib/knownSync.js';
import { deckNames } from '../lib/ankiconnect.js';
import { loadHistory, recordSnapshot } from '../lib/knownHistory.js';

type SyncBody = {
  decks?: string[];
  field?: string;
  knownThresholdDays?: number;
  url?: string;
};

type ImportBody = {
  words?: Record<string, KnownEntry>;
  text?: string;
};

const VALID_STATUS = new Set<WordStatus>(['known', 'learning', 'created', 'ignored']);
const VALID_MARK_STATUS = new Set<WordStatus>(['known', 'ignored']);

/**
 * Returns a copy of the store with every `manual: true` entry from the
 * previous store carried over. Used so /known/sync and /known/import don't
 * stomp on entries the user marked via the review-view hotkeys.
 */
function carryManualEntries(prev: KnownStore, next: KnownStore): KnownStore {
  const merged: KnownStore = {
    updatedAt: next.updatedAt,
    source: next.source,
    words: { ...next.words },
  };
  for (const [lemma, entry] of Object.entries(prev.words)) {
    if (entry.manual) merged.words[lemma] = entry;
  }
  return merged;
}

function parseTextList(text: string): Record<string, KnownEntry> {
  const words: Record<string, KnownEntry> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [word, statusRaw, reading] = trimmed.split('\t');
    if (!word) continue;
    const status = (statusRaw ?? '').trim() as WordStatus;
    words[word.trim()] = {
      status: VALID_STATUS.has(status) ? status : 'known',
      reading: reading?.trim() || undefined,
    };
  }
  return words;
}

export async function knownRoutes(app: FastifyInstance) {
  app.get('/known', async () => {
    const store = await loadKnown();
    return summarize(store);
  });

  app.get('/known/history', async () => {
    return { history: await loadHistory() };
  });

  // Full word list (word + status + reading), newest-matured first.
  app.get('/known/words', async () => {
    const store = await loadKnown();
    const words = Object.entries(store.words)
      .map(([word, entry]) => ({
        word,
        status: entry.status,
        reading: entry.reading ?? '',
        intervalDays: entry.intervalDays ?? 0,
      }))
      .sort((a, b) => b.intervalDays - a.intervalDays);
    return { words };
  });

  // Deck names so the client can let the user pick the vocabulary source.
  app.get('/known/decks', async (req, reply) => {
    const { url } = req.query as { url?: string };
    try {
      return { decks: await deckNames(url) };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/known/sync', async (req, reply) => {
    const body = (req.body as SyncBody | undefined) ?? {};
    if (!Array.isArray(body.decks) || body.decks.length === 0) {
      return reply.code(400).send({ error: 'at least one deck is required' });
    }
    if (!body.field) {
      return reply.code(400).send({ error: 'word field is required' });
    }
    try {
      const fresh = await buildKnownFromAnki({
        decks: body.decks,
        field: body.field,
        knownThresholdDays: body.knownThresholdDays,
        url: body.url,
      });
      const prev = await loadKnown();
      const store = carryManualEntries(prev, fresh);
      await saveKnown(store);
      const sum = summarize(store);
      await recordSnapshot({
        known: sum.known,
        learning: sum.learning,
        created: sum.created,
        total: sum.total,
      });
      return sum;
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/known/import', async (req, reply) => {
    const body = (req.body as ImportBody | undefined) ?? {};
    const words =
      body.words && typeof body.words === 'object'
        ? body.words
        : typeof body.text === 'string'
          ? parseTextList(body.text)
          : null;
    if (!words || Object.keys(words).length === 0) {
      return reply.code(400).send({ error: 'provide "words" or a non-empty "text" list' });
    }
    const fresh: KnownStore = { updatedAt: Date.now(), source: 'import', words };
    const prev = await loadKnown();
    const store = carryManualEntries(prev, fresh);
    await saveKnown(store);
    const sum = summarize(store);
    await recordSnapshot({
      known: sum.known,
      learning: sum.learning,
      created: sum.created,
      total: sum.total,
    });
    return sum;
  });

  app.delete('/known', async () => {
    const store = { updatedAt: Date.now(), words: {} };
    await saveKnown(store);
    return summarize(store);
  });

  /**
   * Set / clear the status of a single lemma from the review-view hotkeys.
   * Body: { lemma, status: 'known' | 'ignored' | null, reading? }
   * - 'known'   → marks the word as known (manual=true)
   * - 'ignored' → marks the word as ignored (manual=true)
   * - null      → removes the manual entry, reverting to the Anki-derived
   *               status (or 'new' if none).
   */
  app.post('/known/mark', async (req, reply) => {
    const body = req.body as
      | { lemma?: string; status?: WordStatus | null; reading?: string }
      | undefined;
    const lemma = body?.lemma?.trim();
    if (!lemma) return reply.code(400).send({ error: 'lemma is required' });

    const store = await loadKnown();
    if (body?.status == null) {
      // Clear an existing manual entry. If there's no entry or the entry was
      // not manual, we still delete so the lemma reverts to 'new'.
      delete store.words[lemma];
    } else {
      if (!VALID_MARK_STATUS.has(body.status)) {
        return reply.code(400).send({ error: 'status must be "known", "ignored" or null' });
      }
      const existing = store.words[lemma];
      const entry: KnownEntry = {
        status: body.status,
        manual: true,
        reading: body?.reading || existing?.reading,
        intervalDays: existing?.intervalDays,
      };
      store.words[lemma] = entry;
    }
    store.updatedAt = Date.now();
    await saveKnown(store);
    return { ok: true, lemma, status: store.words[lemma]?.status ?? null };
  });
}
