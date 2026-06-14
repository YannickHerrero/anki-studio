import type { FastifyInstance } from 'fastify';
import { audioPath, requireSession, screenshotPath } from '../lib/session.js';
import { extractAudio, extractScreenshot } from '../lib/ffmpeg.js';
import { mapWithConcurrency } from '../lib/pool.js';

type SseEvent = { event: string; data: unknown };

function sseLine({ event, data }: SseEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function processRoutes(app: FastifyInstance) {
  app.post('/session/:sid/process', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);
    if (session.status === 'processing') {
      return reply.code(409).send({ error: 'already processing' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (e: SseEvent) => reply.raw.write(sseLine(e));

    session.status = 'processing';
    write({ event: 'start', data: { total: session.cards.length } });

    try {
      let audioDone = 0;
      let screenshotDone = 0;
      const total = session.cards.length;

      await mapWithConcurrency(session.cards, 4, async (card) => {
        const audioOut = audioPath(sid, card.index);
        const shotOut = screenshotPath(sid, card.index);

        await Promise.all([
          extractAudio(session.videoPath, audioOut, {
            startMs: card.startMs,
            endMs: card.endMs,
          }).then(() => {
            card.audioReady = true;
            audioDone++;
            write({ event: 'progress', data: { kind: 'audio', done: audioDone, total } });
          }),
          extractScreenshot(session.videoPath, shotOut, {
            startMs: card.startMs,
            endMs: card.endMs,
          }).then(() => {
            card.screenshotReady = true;
            screenshotDone++;
            write({ event: 'progress', data: { kind: 'screenshot', done: screenshotDone, total } });
          }),
        ]);
      });

      session.status = 'ready';
      write({ event: 'done', data: { sessionId: sid } });
    } catch (err) {
      session.status = 'error';
      session.errorMessage = err instanceof Error ? err.message : String(err);
      write({ event: 'error', data: { message: session.errorMessage } });
    } finally {
      reply.raw.end();
    }
  });
}
