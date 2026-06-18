import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireSession, sessionDir } from '../lib/session.js';
import { transcribe } from '../lib/whisper.js';
import { extractFullAudio } from '../lib/ffmpeg.js';
import { persistSession } from '../lib/persistence.js';

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
    if (!body.openaiKey) {
      return reply.code(400).send({ error: 'openaiKey is required' });
    }
    if (!session.videoPath) {
      return reply.code(400).send({ error: 'session has no video to transcribe' });
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

      // Upload sessions don't pre-extract full audio. Do it on demand.
      try {
        await fs.access(audioPath);
      } catch {
        write('audio', { stage: 'extracting' });
        await extractFullAudio(session.videoPath, audioPath, session.audioTrackIndex ?? 0);
        write('audio', { stage: 'done' });
      }

      const { cues, words } = await transcribe({
        apiKey: body.openaiKey,
        audioPath,
        language: body.language ?? 'ja',
      });
      session.cues = cues;
      session.whisperWords = words;
      session.cards = cues.map((c) => ({
        ...c,
        audioReady: false,
        screenshotReady: false,
        rev: 0,
      }));
      persistSession(session, { immediate: true });
      write('done', { cueCount: cues.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
