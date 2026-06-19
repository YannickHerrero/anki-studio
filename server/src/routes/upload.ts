import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import {
  createSession,
  cuesFromSubtitleCues,
  sessionDir,
  type Session,
} from '../lib/session.js';
import { filterCuesToRange, parseSubtitleFile, type SubtitleCue } from '../lib/subtitles.js';
import { persistSession } from '../lib/persistence.js';
import {
  pickJapaneseTrack,
  probeAudioStreams,
  probeDurationMs,
  splitVideoIntoChunks,
  type AudioStream,
  type ChunkInfo,
} from '../lib/ffmpeg.js';

const SUBTITLE_EXTS = new Set(['srt', 'ass', 'ssa', 'vtt']);

/** Above this duration, the upload becomes N sibling sessions. */
const SPLIT_THRESHOLD_MS = 25 * 60 * 1000;
const CHUNK_MS = 25 * 60 * 1000;
const OVERLAP_MS = 5 * 1000;

type SessionSummary = {
  sessionId: string;
  cueCount: number;
  needsTranscription: boolean;
  audioStreams: AudioStream[];
  audioTrackIndex: number | null;
  /** Index in [0, totalChunks). 0 / 1 for a non-split upload. */
  chunkIndex: number;
  totalChunks: number;
  title: string;
};

async function setupSession(args: {
  videoPath: string;
  videoOriginalName: string;
  subtitleCues: SubtitleCue[] | null;
  title: string;
  audioStreams: AudioStream[];
  audioTrackIndex: number | null;
  chunkIndex: number;
  totalChunks: number;
}): Promise<SessionSummary> {
  const session = await createSession();
  const dir = sessionDir(session.id);
  // Move the chunk video into the session dir so the session is self-contained.
  const ext = path.extname(args.videoPath) || '.mp4';
  const dst = path.join(dir, `video${ext}`);
  await fs.promises.rename(args.videoPath, dst);
  session.videoPath = dst;
  session.videoOriginalName = args.videoOriginalName;
  session.title = args.title;
  session.audioStreams = args.audioStreams;
  if (args.audioTrackIndex != null) session.audioTrackIndex = args.audioTrackIndex;

  if (args.subtitleCues) {
    session.cues = cuesFromSubtitleCues(args.subtitleCues);
  }

  try {
    const [stat, durationMs] = await Promise.all([
      fs.promises.stat(session.videoPath),
      probeDurationMs(session.videoPath),
    ]);
    session.videoSize = stat.size;
    session.videoDurationMs = durationMs;
  } catch {
    // non-fatal
  }

  persistSession(session, { immediate: true });

  return {
    sessionId: session.id,
    cueCount: session.cues.length,
    needsTranscription: !args.subtitleCues,
    audioStreams: session.audioStreams ?? [],
    audioTrackIndex: session.audioTrackIndex ?? null,
    chunkIndex: args.chunkIndex,
    totalChunks: args.totalChunks,
    title: args.title,
  };
}

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/upload', async (req, reply) => {
    const parts = req.parts();

    // We don't know yet if the upload will split. Stage the files in a temp
    // dir owned by a temporary session id; we'll either move them into that
    // session's dir or split and move chunks into N child session dirs.
    const tempSession = await createSession();
    const tempDir = sessionDir(tempSession.id);

    let rawVideoPath = '';
    let videoOriginalName = '';
    let subtitlePath = '';
    let subtitleOriginalName = '';

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const filename = part.filename || 'unknown';
      const ext = path.extname(filename).toLowerCase().replace(/^\./, '');

      if (part.fieldname === 'video') {
        const outPath = path.join(tempDir, `raw_video.${ext || 'mkv'}`);
        await pipeline(part.file, fs.createWriteStream(outPath));
        rawVideoPath = outPath;
        videoOriginalName = filename;
      } else if (part.fieldname === 'subtitle') {
        if (!SUBTITLE_EXTS.has(ext)) {
          part.file.resume();
          await fs.promises.rm(tempDir, { recursive: true, force: true });
          return reply.code(400).send({ error: `unsupported subtitle format: ${ext}` });
        }
        const outPath = path.join(tempDir, `subs.${ext}`);
        await pipeline(part.file, fs.createWriteStream(outPath));
        subtitlePath = outPath;
        subtitleOriginalName = filename;
      } else {
        part.file.resume();
      }
    }

    if (!rawVideoPath) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
      return reply.code(400).send({ error: '"video" file is required' });
    }

    // Parse subtitle once (in SOURCE-video time) and probe audio + duration.
    let parsedCues: SubtitleCue[] | null = null;
    if (subtitlePath) {
      parsedCues = await parseSubtitleFile(subtitlePath);
    }

    let durationMs = 0;
    try {
      durationMs = await probeDurationMs(rawVideoPath);
    } catch {
      // Best-effort: if we can't determine duration we just treat as single chunk.
    }

    let audioStreams: AudioStream[] = [];
    let autoPickedTrack: number | null = null;
    try {
      audioStreams = await probeAudioStreams(rawVideoPath);
      autoPickedTrack = pickJapaneseTrack(audioStreams);
    } catch {
      // ffprobe failure is non-fatal
    }

    // Decide whether to split. The temporary session (tempSession.id) is
    // discarded — we always create the real sessions via setupSession().
    const needsSplit = durationMs > SPLIT_THRESHOLD_MS;
    let chunks: ChunkInfo[];
    if (needsSplit) {
      chunks = await splitVideoIntoChunks(
        rawVideoPath,
        tempDir,
        durationMs,
        CHUNK_MS,
        OVERLAP_MS,
      );
    } else {
      chunks = [
        {
          index: 0,
          videoPath: rawVideoPath,
          sourceStartMs: 0,
          sourceEndMs: durationMs || Number.MAX_SAFE_INTEGER,
          totalChunks: 1,
        },
      ];
    }

    const baseTitle = videoOriginalName || 'Upload';
    const summaries: SessionSummary[] = [];
    for (const chunk of chunks) {
      const chunkCues = parsedCues
        ? filterCuesToRange(parsedCues, chunk.sourceStartMs, chunk.sourceEndMs)
        : null;
      const title =
        chunk.totalChunks === 1
          ? baseTitle
          : `${baseTitle} — part ${chunk.index + 1}/${chunk.totalChunks}`;
      summaries.push(
        await setupSession({
          videoPath: chunk.videoPath,
          videoOriginalName,
          subtitleCues: chunkCues,
          title,
          audioStreams,
          audioTrackIndex: autoPickedTrack,
          chunkIndex: chunk.index,
          totalChunks: chunk.totalChunks,
        }),
      );
    }
    // The temp session dir held the raw upload + chunk files; chunks have
    // since been renamed into their child session dirs. Clean what remains
    // (raw_video, subs, plus the empty temp dir itself).
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    // Also drop the temp session from memory so it doesn't show up anywhere.
    // (createSession registered it; we need to unregister.)
    try {
      const { unregisterSession } = await import('../lib/session.js');
      unregisterSession(tempSession.id);
    } catch {
      // ignore
    }
    void subtitleOriginalName; // currently unused, but kept for future per-chunk metadata

    // Single-session shape for backward compatibility; clients that know
    // about splitting should read `sessions[]`.
    const primary = summaries[0]!;
    return {
      sessionId: primary.sessionId,
      cueCount: primary.cueCount,
      needsTranscription: primary.needsTranscription,
      audioStreams: primary.audioStreams,
      audioTrackIndex: primary.audioTrackIndex,
      sessions: summaries,
      split: summaries.length > 1,
      totalChunks: summaries.length,
      durationMs,
    };
  });
}
