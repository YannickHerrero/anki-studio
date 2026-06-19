import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  createSession,
  cuesFromSubtitleCues,
  sessionDir,
  unregisterSession,
  type Session,
} from '../lib/session.js';
import {
  downloadSubtitles,
  downloadVideo,
  isValidYouTubeUrl,
  probe,
  probeWithSubs,
  validateYtDlp,
} from '../lib/ytdlp.js';
import {
  extractFullAudio,
  probeDurationMs,
  splitVideoIntoChunks,
  type ChunkInfo,
} from '../lib/ffmpeg.js';
import { filterCuesToRange, parseSubtitleFile, type SubtitleCue } from '../lib/subtitles.js';
import { persistSession } from '../lib/persistence.js';

type YouTubeBody = {
  url?: string;
  /** When true, keep the uploader's manual JP subs and skip Whisper. */
  useExistingSubs?: boolean;
  /** yt-dlp lang codes to fetch (e.g. ['ja']). Required when useExistingSubs is true. */
  subLangs?: string[];
};

type ProbeBody = {
  url?: string;
};

const SPLIT_THRESHOLD_MS = 25 * 60 * 1000;
const CHUNK_MS = 25 * 60 * 1000;
const OVERLAP_MS = 5 * 1000;

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function youtubeRoutes(app: FastifyInstance) {
  // Lightweight pre-flight: probe title/duration AND list which Japanese
  // sub languages the uploader provided manually. The client uses this to
  // decide whether to ask the user "keep existing subs or transcribe?".
  app.post('/youtube/probe', async (req, reply) => {
    const body = (req.body as ProbeBody | undefined) ?? {};
    const url = body.url?.trim();
    if (!url || !isValidYouTubeUrl(url)) {
      return reply.code(400).send({ error: 'invalid YouTube URL' });
    }
    try {
      await validateYtDlp();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const result = await probeWithSubs(url);
      return result;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/youtube', async (req, reply) => {
    const body = (req.body as YouTubeBody | undefined) ?? {};
    const url = body.url?.trim();
    if (!url || !isValidYouTubeUrl(url)) {
      return reply.code(400).send({ error: 'invalid YouTube URL' });
    }
    const useExistingSubs = body.useExistingSubs === true;
    const subLangs = Array.isArray(body.subLangs)
      ? body.subLangs.filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    if (useExistingSubs && !subLangs.length) {
      return reply.code(400).send({ error: 'subLangs required when useExistingSubs is true' });
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

    // Stage in a temp session dir; we'll either keep it (short video) or
    // wipe it after fanning out into N chunk sessions.
    const tempSession = await createSession('youtube');
    const tempDir = sessionDir(tempSession.id);
    const createdSessions: Session[] = [];

    try {
      // Probe for title + duration up-front so we can show them in the UI.
      const meta = await probe(url);
      write('meta', { title: meta.title, durationMs: meta.durationMs });

      // Download video to the temp staging dir.
      const { videoPath } = await downloadVideo({
        url,
        outDir: tempDir,
        onProgress: (pct) => write('download', { pct }),
      });

      // Optionally fetch the uploader's manual JP subs. These are in
      // SOURCE-video time and will be sliced per chunk further down.
      // Falls back to transcription if yt-dlp returns nothing parseable.
      let parsedSubCues: SubtitleCue[] | null = null;
      if (useExistingSubs) {
        try {
          write('subs', { stage: 'downloading' });
          const subPath = await downloadSubtitles(url, tempDir, subLangs);
          if (subPath) {
            parsedSubCues = await parseSubtitleFile(subPath);
            if (parsedSubCues.length === 0) parsedSubCues = null;
          }
          write('subs', {
            stage: 'done',
            cueCount: parsedSubCues?.length ?? 0,
            usedExisting: !!parsedSubCues,
          });
        } catch (err) {
          parsedSubCues = null;
          write('subs', {
            stage: 'done',
            cueCount: 0,
            usedExisting: false,
            warning: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Confirm duration from the actual file (yt-dlp's metadata can be off).
      let durationMs = meta.durationMs;
      try {
        durationMs = (await probeDurationMs(videoPath)) || meta.durationMs;
      } catch {
        // fall back to meta.durationMs
      }

      const needsSplit = durationMs > SPLIT_THRESHOLD_MS;
      let chunks: ChunkInfo[];
      if (needsSplit) {
        write('split', {
          durationMs,
          chunkMs: CHUNK_MS,
        });
        chunks = await splitVideoIntoChunks(
          videoPath,
          tempDir,
          durationMs,
          CHUNK_MS,
          OVERLAP_MS,
        );
      } else {
        chunks = [
          {
            index: 0,
            videoPath,
            sourceStartMs: 0,
            sourceEndMs: durationMs,
            totalChunks: 1,
          },
        ];
      }

      const sessionSummaries: Array<{
        sessionId: string;
        chunkIndex: number;
        totalChunks: number;
        title: string;
        durationMs: number;
        cueCount: number;
        needsTranscription: boolean;
      }> = [];

      for (const chunk of chunks) {
        const session = await createSession('youtube');
        createdSessions.push(session);
        session.youtubeUrl = url;
        // Keep the title clean — the UI renders the part-of-N badge in front.
        session.title = meta.title;
        if (chunk.totalChunks > 1) {
          session.chunkIndex = chunk.index;
          session.totalChunks = chunk.totalChunks;
        }
        session.videoOriginalName = path.basename(chunk.videoPath);

        // Move chunk video into the new session dir.
        const dir = sessionDir(session.id);
        const ext = path.extname(chunk.videoPath) || '.mp4';
        const dst = path.join(dir, `video${ext}`);
        await fs.rename(chunk.videoPath, dst);
        session.videoPath = dst;

        try {
          const [stat, dur] = await Promise.all([fs.stat(dst), probeDurationMs(dst)]);
          session.videoSize = stat.size;
          session.videoDurationMs = dur;
        } catch {
          session.videoDurationMs = chunk.sourceEndMs - chunk.sourceStartMs;
        }

        if (parsedSubCues) {
          const chunkCues = filterCuesToRange(
            parsedSubCues,
            chunk.sourceStartMs,
            chunk.sourceEndMs,
          );
          session.cues = cuesFromSubtitleCues(chunkCues);
        }

        // Extract full audio for Whisper, per chunk. Not needed when we're
        // keeping existing subs (Whisper won't run; /process cuts per-cue
        // audio from the video directly).
        if (!parsedSubCues) {
          write('audio', { stage: 'extracting', chunk: chunk.index, of: chunk.totalChunks });
          const fullAudio = path.join(dir, 'full.mp3');
          await extractFullAudio(dst, fullAudio);
        }
        persistSession(session, { immediate: true });

        sessionSummaries.push({
          sessionId: session.id,
          chunkIndex: chunk.index,
          totalChunks: chunk.totalChunks,
          title: session.title,
          durationMs: session.videoDurationMs ?? chunk.sourceEndMs - chunk.sourceStartMs,
          cueCount: session.cues.length,
          needsTranscription: !parsedSubCues,
        });
      }
      if (!parsedSubCues) write('audio', { stage: 'done' });

      // Clean up the staging dir + temp session (it never held real data).
      await fs.rm(tempDir, { recursive: true, force: true });
      unregisterSession(tempSession.id);

      const primary = sessionSummaries[0]!;
      write('done', {
        sessionId: primary.sessionId,
        title: meta.title,
        durationMs,
        sessions: sessionSummaries,
        split: sessionSummaries.length > 1,
        totalChunks: sessionSummaries.length,
        needsTranscription: !parsedSubCues,
        cueCount: primary.cueCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const s of createdSessions) {
        s.status = 'error';
        s.errorMessage = message;
        persistSession(s, { immediate: true });
      }
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
