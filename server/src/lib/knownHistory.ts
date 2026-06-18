import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export type Snapshot = {
  /** Local date, YYYY-MM-DD. One snapshot per day (latest wins). */
  date: string;
  known: number;
  learning: number;
  created: number;
  total: number;
};

function historyPath(): string {
  return path.join(config.tmpDir, 'known-history.json');
}

export async function loadHistory(): Promise<Snapshot[]> {
  try {
    const raw = await fs.readFile(historyPath(), 'utf8');
    const parsed = JSON.parse(raw) as Snapshot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function today(): string {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

// Record one data point per day so the dashboard can chart growth over time.
export async function recordSnapshot(counts: Omit<Snapshot, 'date'>): Promise<void> {
  const history = await loadHistory();
  const date = today();
  const snapshot: Snapshot = { date, ...counts };
  const i = history.findIndex((s) => s.date === date);
  if (i >= 0) history[i] = snapshot;
  else history.push(snapshot);
  history.sort((a, b) => a.date.localeCompare(b.date));
  // Keep ~2 years of daily points; plenty for week-over-week motivation.
  const trimmed = history.slice(-730);

  const out = historyPath();
  const tmp = `${out}.tmp`;
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(trimmed));
  await fs.rename(tmp, out);
}
