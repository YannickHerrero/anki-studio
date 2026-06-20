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

export type AnkiNoteInfo = {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
};

export async function findNotes(query: string, url?: string): Promise<number[]> {
  return invoke<number[]>('findNotes', { query }, url);
}

export async function notesInfo(noteIds: number[], url?: string): Promise<AnkiNoteInfo[]> {
  if (noteIds.length === 0) return [];
  return invoke<AnkiNoteInfo[]>('notesInfo', { notes: noteIds }, url);
}

export async function updateNoteFields(
  params: { id: number; fields: Record<string, string> },
  url?: string,
): Promise<unknown> {
  return invoke<unknown>(
    'updateNoteFields',
    { note: { id: params.id, fields: params.fields } },
    url,
  );
}

// --- Note-type (model) writers --------------------------------------------
// Used by the /anki/sync-model endpoint so the user can iterate on the
// shipped template + CSS without re-exporting an .apkg.

export type CreateModelTemplate = {
  Name: string;
  Front: string;
  Back: string;
};

export async function modelNames(url?: string): Promise<string[]> {
  return invoke<string[]>('modelNames', {}, url);
}

export async function modelFieldNames(modelName: string, url?: string): Promise<string[]> {
  return invoke<string[]>('modelFieldNames', { modelName }, url);
}

export async function modelFieldAdd(
  params: { modelName: string; fieldName: string; index?: number },
  url?: string,
): Promise<unknown> {
  return invoke<unknown>(
    'modelFieldAdd',
    {
      modelName: params.modelName,
      fieldName: params.fieldName,
      ...(params.index != null ? { index: params.index } : {}),
    },
    url,
  );
}

export async function createModel(
  params: {
    modelName: string;
    inOrderFields: string[];
    css: string;
    cardTemplates: CreateModelTemplate[];
    isCloze?: boolean;
  },
  url?: string,
): Promise<unknown> {
  return invoke<unknown>(
    'createModel',
    {
      modelName: params.modelName,
      inOrderFields: params.inOrderFields,
      css: params.css,
      isCloze: params.isCloze ?? false,
      cardTemplates: params.cardTemplates,
    },
    url,
  );
}

/**
 * Replace the qfmt/afmt of every card template on the given model. Anki's
 * AnkiConnect updateModelTemplates takes a per-template map keyed by name.
 */
export async function updateModelTemplates(
  params: { name: string; templates: Record<string, { Front: string; Back: string }> },
  url?: string,
): Promise<unknown> {
  return invoke<unknown>(
    'updateModelTemplates',
    { model: { name: params.name, templates: params.templates } },
    url,
  );
}

export async function updateModelStyling(
  params: { name: string; css: string },
  url?: string,
): Promise<unknown> {
  return invoke<unknown>(
    'updateModelStyling',
    { model: { name: params.name, css: params.css } },
    url,
  );
}
