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
    if (session.videoRemoved) {
      return reply.code(409).send({ error: 'video removed — re-link it to retime' });
    }

    const from = Math.max(0, Math.floor(body.fromIndex ?? 0));
    const affected = session.cues.slice(from);

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
      for (const cue of affected) {
        cue.startMs = Math.max(0, cue.startMs + delta);
        cue.endMs = Math.max(cue.startMs + 1, cue.endMs + delta);
        cue.audioReady = false;
        cue.screenshotReady = false;
        cue.rev += 1;
      }

      let done = 0;
      await mapWithConcurrency(affected, 4, async (cue) => {
        await Promise.all([
          extractAudio(session.videoPath, audioPath(sid, cue.index), {
            startMs: cue.startMs,
            endMs: cue.endMs,
            audioTrackIndex: session.audioTrackIndex,
          }).then(() => {
            cue.audioReady = true;
          }),
          extractScreenshot(session.videoPath, screenshotPath(sid, cue.index), {
            startMs: cue.startMs,
            endMs: cue.endMs,
          }).then(() => {
            cue.screenshotReady = true;
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
