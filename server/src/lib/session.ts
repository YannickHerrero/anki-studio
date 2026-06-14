import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import type { SubtitleCue } from './subtitles.js';

export type Decision = 'keep' | 'skip';

export type Card = SubtitleCue & {
  audioReady: boolean;
  screenshotReady: boolean;
};

export type ProcessingStatus = 'pending' | 'processing' | 'ready' | 'error';

export type Session = {
  id: string;
  createdAt: number;
  videoPath: string;
  videoOriginalName: string;
  subtitlePath: string;
  subtitleOriginalName: string;
  cues: SubtitleCue[];
  cards: Card[];
  decisions: Record<number, Decision>;
  status: ProcessingStatus;
  errorMessage?: string;
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

export async function createSession(): Promise<Session> {
  const id = randomUUID();
  const dir = sessionDir(id);
  await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
  await fs.mkdir(path.join(dir, 'image'), { recursive: true });

  const session: Session = {
    id,
    createdAt: Date.now(),
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
