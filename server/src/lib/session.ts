import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { SubtitleCue } from './subtitles.js';
import type { WhisperWord } from './whisper.js';

export type Decision = 'keep' | 'skip';

export type Card = SubtitleCue & {
  audioReady: boolean;
  screenshotReady: boolean;
  rev: number;
  exported?: boolean;
};

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
  subtitlePath: string;
  subtitleOriginalName: string;
  cues: SubtitleCue[];
  cards: Card[];
  whisperWords?: WhisperWord[];
  decisions: Record<number, Decision>;
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
    cards: [],
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
