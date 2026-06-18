import type { FastifyInstance } from 'fastify';
import { audioPath, requireSession, screenshotPath } from '../lib/session.js';
import { extractAudio, extractScreenshot } from '../lib/ffmpeg.js';
import { mapWithConcurrency } from '../lib/pool.js';
import { persistSession } from '../lib/persistence.js';

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
    persistSession(session, { immediate: true });
    write({ event: 'start', data: { total: session.cues.length } });

    try {
      let audioDone = 0;
      let screenshotDone = 0;
      const total = session.cues.length;

      await mapWithConcurrency(session.cues, 4, async (cue) => {
        const audioOut = audioPath(sid, cue.index);
        const shotOut = screenshotPath(sid, cue.index);

        await Promise.all([
          extractAudio(session.videoPath, audioOut, {
            startMs: cue.startMs,
            endMs: cue.endMs,
            audioTrackIndex: session.audioTrackIndex,
          }).then(() => {
            cue.audioReady = true;
            audioDone++;
            persistSession(session);
            write({ event: 'progress', data: { kind: 'audio', done: audioDone, total } });
          }),
          extractScreenshot(session.videoPath, shotOut, {
            startMs: cue.startMs,
            endMs: cue.endMs,
          }).then(() => {
            cue.screenshotReady = true;
            screenshotDone++;
            persistSession(session);
            write({ event: 'progress', data: { kind: 'screenshot', done: screenshotDone, total } });
          }),
        ]);
      });

      session.status = 'ready';
      persistSession(session, { immediate: true });
      write({ event: 'done', data: { sessionId: sid } });
    } catch (err) {
      session.status = 'error';
      session.errorMessage = err instanceof Error ? err.message : String(err);
      persistSession(session, { immediate: true });
      write({ event: 'error', data: { message: session.errorMessage } });
    } finally {
      reply.raw.end();
    }
  });
}
