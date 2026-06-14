import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  registerSession,
  sessionDir,
  type Session,
} from './session.js';

const STATE_FILENAME = 'session.json';

function statePath(sid: string): string {
  return path.join(sessionDir(sid), STATE_FILENAME);
}

// Lightweight debounce keyed by session id so high-frequency mutations
// (decision changes, processing progress) don't thrash the disk.
const pending = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 300;

export function persistSession(session: Session, options?: { immediate?: boolean }): void {
  session.updatedAt = Date.now();
  if (options?.immediate) {
    void writeNow(session);
    return;
  }
  const existing = pending.get(session.id);
  if (existing) clearTimeout(existing);
  pending.set(
    session.id,
    setTimeout(() => {
      pending.delete(session.id);
      void writeNow(session);
    }, DEBOUNCE_MS),
  );
}

async function writeNow(session: Session): Promise<void> {
  const out = statePath(session.id);
  const tmp = `${out}.tmp`;
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(session));
  await fs.rename(tmp, out);
}

export async function rehydrateSessions(): Promise<number> {
  const dir = config.tmpDir;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const entry of entries) {
    const file = path.join(dir, entry, STATE_FILENAME);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const session = JSON.parse(raw) as Session;
      if (!session.id) continue;
      // An interrupted processing run can't reliably finish across a restart;
      // surface that to the user instead of pretending nothing happened.
      if (session.status === 'processing') {
        session.status = 'error';
        session.errorMessage = 'processing was interrupted; please re-run';
      }
      registerSession(session);
      loaded++;
    } catch {
      // skip broken / missing state files silently
    }
  }
  return loaded;
}

export async function deleteSession(sid: string): Promise<void> {
  pending.delete(sid);
  await fs.rm(sessionDir(sid), { recursive: true, force: true });
}
