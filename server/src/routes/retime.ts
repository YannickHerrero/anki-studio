import type { FastifyInstance } from 'fastify';
import { audioPath, requireSession, screenshotPath } from '../lib/session.js';
import { extractAudio, extractScreenshot } from '../lib/ffmpeg.js';
import { mapWithConcurrency } from '../lib/pool.js';
import { persistSession } from '../lib/persistence.js';

type RetimeBody = {
  deltaMs?: number;
  fromIndex?: number;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function retimeRoutes(app: FastifyInstance) {
  app.post('/session/:sid/retime', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as RetimeBody | undefined) ?? {};
    const session = requireSession(sid);

    const delta = Math.round(body.deltaMs ?? 0);
    if (!Number.isFinite(delta) || delta === 0) {
      return reply.code(400).send({ error: 'deltaMs must be a non-zero number' });
    }

    const from = Math.max(0, Math.floor(body.fromIndex ?? 0));
    const affected = session.cards.slice(from);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    write('start', { total: affected.length, deltaMs: delta, fromIndex: from });

    try {
      // Apply timing change first so the session reflects the new state even if
      // re-cutting media partially fails.
      for (const card of affected) {
        card.startMs = Math.max(0, card.startMs + delta);
        card.endMs = Math.max(card.startMs + 1, card.endMs + delta);
        card.audioReady = false;
        card.screenshotReady = false;
        card.rev += 1;
      }

      let done = 0;
      await mapWithConcurrency(affected, 4, async (card) => {
        await Promise.all([
          extractAudio(session.videoPath, audioPath(sid, card.index), {
            startMs: card.startMs,
            endMs: card.endMs,
          }).then(() => {
            card.audioReady = true;
          }),
          extractScreenshot(session.videoPath, screenshotPath(sid, card.index), {
            startMs: card.startMs,
            endMs: card.endMs,
          }).then(() => {
            card.screenshotReady = true;
          }),
        ]);
        done++;
        write('progress', { done, total: affected.length });
      });

      persistSession(session, { immediate: true });
      write('done', { affected: affected.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
