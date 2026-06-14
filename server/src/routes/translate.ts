import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/session.js';
import { translateBatch } from '../lib/openrouter.js';
import { persistSession } from '../lib/persistence.js';

type TranslateBody = {
  openrouterKey?: string;
  model?: string;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function translateRoutes(app: FastifyInstance) {
  app.post('/session/:sid/translate', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as TranslateBody | undefined) ?? {};
    const session = requireSession(sid);
    if (!body.openrouterKey || !body.model) {
      return reply.code(400).send({ error: 'openrouterKey and model are required' });
    }
    if (session.cards.length === 0) {
      return reply.code(400).send({ error: 'no cues to translate yet' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', { count: session.cards.length });
      const sentences = session.cards.map((c) => c.text);
      const translations = await translateBatch(sentences, {
        apiKey: body.openrouterKey,
        model: body.model,
      });
      session.cards.forEach((card, i) => {
        const t = translations[i] ?? '';
        card.translation = t;
        const cue = session.cues.find((c) => c.index === card.index);
        if (cue) cue.translation = t;
      });
      persistSession(session, { immediate: true });
      write('done', { translatedCount: translations.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
