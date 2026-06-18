import type { FastifyInstance } from 'fastify';
import { cuesFromSubtitleCues, requireSession } from '../lib/session.js';
import { refineSentenceBoundaries } from '../lib/openrouter.js';
import { cuesFromBoundaries } from '../lib/whisper.js';
import { persistSession } from '../lib/persistence.js';

type Body = {
  openrouterKey?: string;
  model?: string;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function refineSplitsRoutes(app: FastifyInstance) {
  app.post('/session/:sid/refineSplits', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as Body | undefined) ?? {};
    const session = requireSession(sid);

    if (!body.openrouterKey || !body.model) {
      return reply.code(400).send({ error: 'openrouterKey and model are required' });
    }
    const words = session.whisperWords ?? [];
    if (words.length === 0) {
      return reply.code(400).send({ error: 'no whisper words on this session' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', { wordCount: words.length });

      const boundaries = await refineSentenceBoundaries(words, {
        apiKey: body.openrouterKey,
        model: body.model,
      });

      // Soft validation: if the model returned nothing useful, keep the cues
      // we already have and surface a warning instead of clobbering them.
      if (boundaries.length === 0) {
        write('done', {
          cueCount: session.cues.length,
          warning: 'model returned no boundaries; cues unchanged',
        });
        return;
      }

      const newCues = cuesFromBoundaries(words, boundaries);
      if (newCues.length === 0) {
        write('done', {
          cueCount: session.cues.length,
          warning: 'boundaries produced no cues; cues unchanged',
        });
        return;
      }

      session.cues = cuesFromSubtitleCues(newCues);
      // Picks referenced the old cue indices and no longer make sense.
      session.picks = [];
      persistSession(session, { immediate: true });
      write('done', { cueCount: newCues.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
