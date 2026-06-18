import type { FastifyInstance } from 'fastify';
import { loadKnown, saveKnown, summarize, type KnownEntry, type WordStatus } from '../lib/knownWords.js';
import { buildKnownFromAnki } from '../lib/knownSync.js';
import { deckNames } from '../lib/ankiconnect.js';

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

const VALID_STATUS = new Set<WordStatus>(['known', 'learning', 'created']);

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
      const store = await buildKnownFromAnki({
        decks: body.decks,
        field: body.field,
        knownThresholdDays: body.knownThresholdDays,
        url: body.url,
      });
      await saveKnown(store);
      return summarize(store);
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
    const store = { updatedAt: Date.now(), source: 'import', words };
    await saveKnown(store);
    return summarize(store);
  });

  app.delete('/known', async () => {
    const store = { updatedAt: Date.now(), words: {} };
    await saveKnown(store);
    return summarize(store);
  });
}
