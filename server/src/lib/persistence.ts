import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  registerSession,
  sessionDir,
  unregisterSession,
  type Session,
} from './session.js';

const STATE_FILENAME = 'session.json';

/**
 * Bumped when the on-disk Session shape changes incompatibly. Sessions whose
 * stored version is lower are deleted on boot (and the user starts over).
 * v2 introduced vocab cards (`picks` pile) and removed `cards`/`decisions`.
 */
export const SESSION_SCHEMA_VERSION = 2;

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
  // Always stamp the current schema version so re-loads work.
  const stamped = { ...session, schemaVersion: SESSION_SCHEMA_VERSION };
  await fs.writeFile(tmp, JSON.stringify(stamped));
  await fs.rename(tmp, out);
}

export async function rehydrateSessions(): Promise<{ loaded: number; wiped: number }> {
  const dir = config.tmpDir;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { loaded: 0, wiped: 0 };
  }
  let loaded = 0;
  let wiped = 0;
  for (const entry of entries) {
    const sessionPath = path.join(dir, entry);
    const file = path.join(sessionPath, STATE_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      // No session.json — not one of our session dirs; leave it alone.
      continue;
    }
    let parsed: (Session & { schemaVersion?: number }) | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Broken JSON — wipe so it doesn't sit around forever.
      await fs.rm(sessionPath, { recursive: true, force: true });
      wiped++;
      continue;
    }
    const version = parsed?.schemaVersion ?? 1;
    if (version < SESSION_SCHEMA_VERSION) {
      // Incompatible schema (e.g. pre-vocab-card sentence sessions). Wipe.
      await fs.rm(sessionPath, { recursive: true, force: true });
      wiped++;
      continue;
    }
    if (!parsed?.id) continue;
    // An interrupted processing run can't reliably finish across a restart;
    // surface that to the user instead of pretending nothing happened.
    if (parsed.status === 'processing') {
      parsed.status = 'error';
      parsed.errorMessage = 'processing was interrupted; please re-run';
    }
    registerSession(parsed);
    loaded++;
  }
  return { loaded, wiped };
}

export async function deleteSession(sid: string): Promise<void> {
  const existing = pending.get(sid);
  if (existing) clearTimeout(existing);
  pending.delete(sid);
  unregisterSession(sid);
  await fs.rm(sessionDir(sid), { recursive: true, force: true });
}
