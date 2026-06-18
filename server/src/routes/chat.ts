import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/session.js';
import { streamSubtitleChat, type ChatMessage } from '../lib/chat.js';

type ChatBody = {
  index?: number;
  messages?: ChatMessage[];
  openrouterKey?: string;
  model?: string;
  appName?: string;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function chatRoutes(app: FastifyInstance) {
  app.post('/session/:sid/chat', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as ChatBody | undefined) ?? {};
    const session = requireSession(sid);

    if (!body.openrouterKey || !body.model) {
      return reply.code(400).send({ error: 'openrouterKey and model are required' });
    }
    if (typeof body.index !== 'number') {
      return reply.code(400).send({ error: 'index is required' });
    }
    const current = session.cues.find((c) => c.index === body.index);
    if (!current) {
      return reply.code(404).send({ error: `no card at index ${body.index}` });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', { index: current.index });
      await streamSubtitleChat(
        messages,
        {
          index: current.index,
          text: current.text,
          translation: current.translation,
          note: current.note,
          transcript: session.cues.map((c) => ({
            index: c.index,
            text: c.text,
            translation: c.translation,
          })),
        },
        { apiKey: body.openrouterKey, model: body.model, appName: body.appName },
        (event) => write(event.type, event),
      );
      write('done', {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
