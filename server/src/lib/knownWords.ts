import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export type WordStatus = 'known' | 'learning' | 'created' | 'ignored';

export type KnownEntry = {
  status: WordStatus;
  reading?: string;
  intervalDays?: number;
  /** True when the user set this in the review UI (1/0 hotkeys). Sync preserves these. */
  manual?: boolean;
};

export type KnownStore = {
  updatedAt: number;
  /** Where the list came from, e.g. "ankiconnect" or "import". */
  source?: string;
  words: Record<string, KnownEntry>;
};

// Single global store shared across all sessions — your Anki vocabulary doesn't
// belong to any one mining session.
function storePath(): string {
  return path.join(config.tmpDir, 'known-words.json');
}

let cache: KnownStore | null = null;

function empty(): KnownStore {
  return { updatedAt: 0, words: {} };
}

export async function loadKnown(): Promise<KnownStore> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    cache = JSON.parse(raw) as KnownStore;
  } catch {
    cache = empty();
  }
  return cache;
}

export async function saveKnown(store: KnownStore): Promise<void> {
  cache = store;
  const out = storePath();
  const tmp = `${out}.tmp`;
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(store));
  await fs.rename(tmp, out);
}

export function summarize(store: KnownStore): {
  total: number;
  known: number;
  learning: number;
  created: number;
  ignored: number;
  updatedAt: number;
  source?: string;
} {
  let known = 0;
  let learning = 0;
  let created = 0;
  let ignored = 0;
  for (const entry of Object.values(store.words)) {
    if (entry.status === 'known') known++;
    else if (entry.status === 'learning') learning++;
    else if (entry.status === 'ignored') ignored++;
    else created++;
  }
  return {
    // 'ignored' is excluded from total — it's a "skip me" mark, not vocabulary.
    total: known + learning + created,
    known,
    learning,
    created,
    ignored,
    updatedAt: store.updatedAt,
    source: store.source,
  };
}
