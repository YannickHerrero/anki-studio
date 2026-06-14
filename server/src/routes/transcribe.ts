import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireSession, sessionDir } from '../lib/session.js';
import { transcribe } from '../lib/whisper.js';

type TranscribeBody = {
  openaiKey?: string;
  language?: string;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function transcribeRoutes(app: FastifyInstance) {
  app.post('/session/:sid/transcribe', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as TranscribeBody | undefined) ?? {};
    const session = requireSession(sid);
    if (session.source !== 'youtube') {
      return reply.code(400).send({ error: 'transcribe is only valid for YouTube sessions' });
    }
    if (!body.openaiKey) {
      return reply.code(400).send({ error: 'openaiKey is required' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', {});
      const audioPath = path.join(sessionDir(sid), 'full.mp3');
      const cues = await transcribe({
        apiKey: body.openaiKey,
        audioPath,
        language: body.language ?? 'ja',
      });
      session.cues = cues;
      session.cards = cues.map((c) => ({
        ...c,
        audioReady: false,
        screenshotReady: false,
        rev: 0,
      }));
      write('done', { cueCount: cues.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
