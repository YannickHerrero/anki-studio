import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createSession, sessionDir } from '../lib/session.js';
import { downloadVideo, isValidYouTubeUrl, probe, validateYtDlp } from '../lib/ytdlp.js';
import { extractFullAudio, probeDurationMs } from '../lib/ffmpeg.js';
import { persistSession } from '../lib/persistence.js';

type YouTubeBody = {
  url?: string;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function youtubeRoutes(app: FastifyInstance) {
  app.post('/youtube', async (req, reply) => {
    const body = (req.body as YouTubeBody | undefined) ?? {};
    const url = body.url?.trim();
    if (!url || !isValidYouTubeUrl(url)) {
      return reply.code(400).send({ error: 'invalid YouTube URL' });
    }

    try {
      await validateYtDlp();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    let session;
    try {
      session = await createSession('youtube');
      session.youtubeUrl = url;
      persistSession(session, { immediate: true });
      write('session', { sessionId: session.id });

      // Probe for title + duration so we can show them in the UI.
      const meta = await probe(url);
      session.title = meta.title;
      persistSession(session);
      write('meta', { title: meta.title, durationMs: meta.durationMs });

      // Download video. Progress is yt-dlp percentage 0..100.
      const dir = sessionDir(session.id);
      const { videoPath } = await downloadVideo({
        url,
        outDir: dir,
        onProgress: (pct) => write('download', { pct }),
      });
      session.videoPath = videoPath;
      session.videoOriginalName = path.basename(videoPath);

      // Fingerprint the downloaded file so a later re-download can be verified.
      try {
        const [stat, durationMs] = await Promise.all([
          fs.stat(videoPath),
          probeDurationMs(videoPath),
        ]);
        session.videoSize = stat.size;
        session.videoDurationMs = durationMs || meta.durationMs;
      } catch {
        session.videoDurationMs = meta.durationMs;
      }

      // Extract full audio for Whisper.
      write('audio', { stage: 'extracting' });
      const fullAudio = path.join(dir, 'full.mp3');
      await extractFullAudio(videoPath, fullAudio);
      persistSession(session, { immediate: true });
      write('audio', { stage: 'done' });

      write('done', {
        sessionId: session.id,
        title: meta.title,
        durationMs: meta.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (session) {
        session.status = 'error';
        session.errorMessage = message;
        persistSession(session, { immediate: true });
      }
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
