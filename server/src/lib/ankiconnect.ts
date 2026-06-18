// Thin client for the AnkiConnect add-on's localhost HTTP API. We only read:
// deck names, card ids by query, and per-card info (interval / type / fields).
// All learning-policy logic (the known/learning thresholds) lives elsewhere.

export const DEFAULT_ANKICONNECT_URL = 'http://127.0.0.1:8765';

type AnkiResponse<T> = { result: T; error: string | null };

async function invoke<T>(
  action: string,
  params: Record<string, unknown>,
  url = DEFAULT_ANKICONNECT_URL,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch {
    throw new Error(
      `Could not reach AnkiConnect at ${url}. Is Anki running with the AnkiConnect add-on installed?`,
    );
  }
  if (!res.ok) throw new Error(`AnkiConnect HTTP ${res.status}`);
  const json = (await res.json()) as AnkiResponse<T>;
  if (json.error) throw new Error(`AnkiConnect: ${json.error}`);
  return json.result;
}

export type AnkiCardInfo = {
  cardId: number;
  /** Current interval in days (negative for in-seconds learning steps). */
  interval: number;
  /** 0 = new, 1 = learning, 2 = review, 3 = relearning. */
  type: number;
  queue: number;
  reps: number;
  deckName: string;
  modelName: string;
  fields: Record<string, { value: string; order: number }>;
};

export async function deckNames(url?: string): Promise<string[]> {
  return invoke<string[]>('deckNames', {}, url);
}

export async function findCards(query: string, url?: string): Promise<number[]> {
  return invoke<number[]>('findCards', { query }, url);
}

export async function cardsInfo(cardIds: number[], url?: string): Promise<AnkiCardInfo[]> {
  if (cardIds.length === 0) return [];
  return invoke<AnkiCardInfo[]>('cardsInfo', { cards: cardIds }, url);
}
