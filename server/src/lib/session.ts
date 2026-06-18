import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { SubtitleCue } from './subtitles.js';
import type { WhisperWord } from './whisper.js';
import type { AudioStream } from './ffmpeg.js';

export type Decision = 'keep' | 'skip';

/**
 * A subtitle line in a session: the parsed text + ingest-time timing PLUS
 * any media-processing state. Replaces the older `Card` type — there is no
 * longer a 1:1 relationship between a cue and an Anki card.
 */
export type Cue = SubtitleCue & {
  audioReady: boolean;
  screenshotReady: boolean;
  rev: number;
  /** @deprecated moves to Pick when /export is rebuilt around the pile. */
  exported?: boolean;
};

export type WordDetails = {
  /** Short, context-aware definition for the lemma as used in this sentence. */
  definition: string;
  /** Canonical hiragana reading. */
  reading: string;
  /** e.g. "[2]" — empty if the model doesn't know. */
  pitchPattern?: string;
  /** "very common", "common", "uncommon", "rare". */
  frequency?: string;
  partOfSpeech?: string;
  usageNotes?: string;
};

/**
 * A single chosen target word — one card to ship in the next .apkg.
 * id is unique within a session: same word picked from two different cues
 * produces two picks with different ids and different example sentences.
 */
export type Pick = {
  id: string;
  cueIndex: number;
  lemma: string;
  surface: string;
  reading: string;
  addedAt: number;
  exported?: boolean;
  /** Filled at export time and persisted so re-export is cheap. */
  details?: WordDetails;
};

export function pickId(cueIndex: number, lemma: string): string {
  return `${cueIndex}_${lemma}`;
}

export type ProcessingStatus = 'pending' | 'processing' | 'ready' | 'error';

export type SessionSource = 'upload' | 'youtube';

export type Session = {
  id: string;
  createdAt: number;
  updatedAt: number;
  source: SessionSource;
  title?: string;
  youtubeUrl?: string;
  videoPath: string;
  videoOriginalName: string;
  /** Duration of the source video in ms, captured at ingest — used to verify a re-linked file. */
  videoDurationMs?: number;
  /** Byte size of the source video, captured at ingest. */
  videoSize?: number;
  /** True once the source video has been deleted to free disk space. */
  videoRemoved?: boolean;
  subtitlePath: string;
  subtitleOriginalName: string;
  cues: Cue[];
  picks: Pick[];
  audioStreams?: AudioStream[];
  audioTrackIndex?: number;
  whisperWords?: WhisperWord[];
  /** @deprecated removed in the next commit when /decisions is dropped. */
  decisions?: Record<number, Decision>;
  status: ProcessingStatus;
  errorMessage?: string;
  lastApkgPath?: string;
  lastApkgName?: string;
};

const sessions = new Map<string, Session>();

export function sessionDir(sid: string): string {
  return path.join(config.tmpDir, sid);
}

export function audioPath(sid: string, index: number): string {
  return path.join(sessionDir(sid), 'audio', `${index}.mp3`);
}

export function screenshotPath(sid: string, index: number): string {
  return path.join(sessionDir(sid), 'image', `${index}.jpg`);
}

export async function createSession(source: SessionSource = 'upload'): Promise<Session> {
  const id = randomUUID();
  const dir = sessionDir(id);
  await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
  await fs.mkdir(path.join(dir, 'image'), { recursive: true });

  const now = Date.now();
  const session: Session = {
    id,
    createdAt: now,
    updatedAt: now,
    source,
    videoPath: '',
    videoOriginalName: '',
    subtitlePath: '',
    subtitleOriginalName: '',
    cues: [],
    picks: [],
    decisions: {},
    status: 'pending',
  };
  sessions.set(id, session);
  return session;
}

export function allSessions(): Session[] {
  return Array.from(sessions.values());
}

export function registerSession(session: Session): void {
  sessions.set(session.id, session);
}

export function unregisterSession(sid: string): void {
  sessions.delete(sid);
}

export function getSession(sid: string): Session | undefined {
  return sessions.get(sid);
}

export function requireSession(sid: string): Session {
  const s = sessions.get(sid);
  if (!s) throw new Error(`unknown session: ${sid}`);
  return s;
}

export async function discardSession(sid: string): Promise<void> {
  sessions.delete(sid);
  await fs.rm(sessionDir(sid), { recursive: true, force: true });
}

/** Helper for routes that turn freshly-parsed cues into Cue[]. */
export function cuesFromSubtitleCues(input: SubtitleCue[]): Cue[] {
  return input.map((c) => ({
    ...c,
    audioReady: false,
    screenshotReady: false,
    rev: 0,
  }));
}
