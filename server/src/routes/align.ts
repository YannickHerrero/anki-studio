import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireSession, sessionDir } from '../lib/session.js';
import { transcribe } from '../lib/whisper.js';
import { extractFullAudio } from '../lib/ffmpeg.js';
import { alignCues } from '../lib/alignment.js';
import { persistSession } from '../lib/persistence.js';

type Body = {
  openaiKey?: string;
  language?: string;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function alignRoutes(app: FastifyInstance) {
  app.post('/session/:sid/align', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as Body | undefined) ?? {};
    const session = requireSession(sid);

    if (!body.openaiKey) {
      return reply.code(400).send({ error: 'openaiKey is required' });
    }
    if (session.cues.length === 0) {
      return reply.code(400).send({ error: 'no cues to align — upload a subtitle file first' });
    }
    if (!session.videoPath || session.videoRemoved) {
      return reply.code(409).send({ error: 'video removed — re-link it to align' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', { cueCount: session.cues.length });

      // Reuse words from a previous /transcribe if available; otherwise run Whisper.
      let words = session.whisperWords ?? [];
      if (words.length === 0) {
        const audioPath = path.join(sessionDir(sid), 'full.mp3');
        try {
          await fs.access(audioPath);
        } catch {
          write('audio', { stage: 'extracting' });
          await extractFullAudio(session.videoPath, audioPath, session.audioTrackIndex ?? 0);
          write('audio', { stage: 'done' });
        }

        write('whisper', { stage: 'transcribing' });
        const { words: w } = await transcribe({
          apiKey: body.openaiKey,
          audioPath,
          language: body.language ?? 'ja',
        });
        words = w;
        session.whisperWords = w;
      }

      write('align', { stage: 'matching' });
      const result = alignCues(session.cues, words);

      // Carry alignment back into the cues in place — keep indices, audioReady,
      // screenshotReady, rev etc. so /process can re-cut only the cues that moved.
      const newByIndex = new Map(result.cues.map((c) => [c.index, c]));
      for (const cue of session.cues) {
        const fresh = newByIndex.get(cue.index);
        if (!fresh) continue;
        if (fresh.startMs !== cue.startMs || fresh.endMs !== cue.endMs) {
          cue.startMs = fresh.startMs;
          cue.endMs = fresh.endMs;
          cue.audioReady = false;
          cue.screenshotReady = false;
          cue.rev += 1;
        }
      }

      persistSession(session, { immediate: true });
      write('done', { aligned: result.aligned, skipped: result.skipped });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
