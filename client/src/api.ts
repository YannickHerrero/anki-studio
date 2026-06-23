export type CardSummary = {
  index: number;
  text: string;
  translation?: string;
  note?: string;
  startMs: number;
  endMs: number;
  audioUrl: string;
  screenshotUrl: string;
  audioReady: boolean;
  screenshotReady: boolean;
  rev: number;
};

export type PickSummary = {
  id: string;
  cueIndex: number;
  lemma: string;
  surface: string;
  reading: string;
  addedAt: number;
  exported: boolean;
};

export type PickTokenInput = {
  surface: string;
  lemma: string;
  reading: string;
};

const BASE = '/api';

export type AudioStream = {
  index: number;
  codec: string;
  channels: number;
  language?: string;
  title?: string;
  isDefault: boolean;
};

export type UploadResult = {
  sessionId: string;
  cueCount: number;
  needsTranscription: boolean;
  audioStreams: AudioStream[];
  audioTrackIndex: number | null;
  /** Present when the upload was split (or even when it wasn't — length == 1). */
  sessions?: Array<{
    sessionId: string;
    cueCount: number;
    needsTranscription: boolean;
    audioStreams: AudioStream[];
    audioTrackIndex: number | null;
    chunkIndex: number;
    totalChunks: number;
    title: string;
  }>;
  split?: boolean;
  totalChunks?: number;
  durationMs?: number;
};

export type YoutubeProbe = {
  title: string;
  durationMs: number;
  /** yt-dlp lang codes the uploader manually provided (excludes auto-captions). */
  manualJapaneseSubs: string[];
};

export type AnkiSyncResult = {
  ok: true;
  /** 'updated' when the model already existed; 'created' on first sync. */
  action: 'updated' | 'created';
  modelName: string;
  /** Fields added to the user's existing model (empty when none / on create). */
  addedFields?: string[];
};

export async function syncAnkiModel(opts: {
  url?: string;
  modelName?: string;
}): Promise<AnkiSyncResult> {
  const res = await fetch(`${BASE}/anki/sync-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sync failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function probeYoutube(url: string): Promise<YoutubeProbe> {
  const res = await fetch(`${BASE}/youtube/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`probe failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function upload(video: File, subtitle: File | null): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('video', video, video.name);
  if (subtitle) fd.append('subtitle', subtitle, subtitle.name);
  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function setAudioTrack(sid: string, audioTrackIndex: number): Promise<void> {
  const res = await fetch(`${BASE}/session/${sid}/audioTrack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioTrackIndex }),
  });
  if (!res.ok) throw new Error(`set audio track failed: ${res.status}`);
}

export async function fetchCards(sid: string): Promise<{
  source: 'upload' | 'youtube';
  videoRemoved: boolean;
  cards: CardSummary[];
}> {
  const res = await fetch(`${BASE}/session/${sid}/cards`);
  if (!res.ok) throw new Error(`fetchCards: ${res.status}`);
  return res.json();
}

export async function fetchPicks(sid: string): Promise<{ picks: PickSummary[] }> {
  const res = await fetch(`${BASE}/session/${sid}/picks`);
  if (!res.ok) throw new Error(`fetchPicks: ${res.status}`);
  return res.json();
}

export async function addPicks(
  sid: string,
  cueIndex: number,
  tokens: PickTokenInput[],
): Promise<{
  addedCount: number;
  added: Array<{ id: string; lemma: string; surface: string }>;
  pileCount: number;
  /** Lemmas whose known-store status changed (e.g. flipped to 'created'). */
  statusChanges: Record<string, WordStatus>;
}> {
  const res = await fetch(`${BASE}/session/${sid}/pick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cueIndex, tokens }),
  });
  if (!res.ok) throw new Error(`addPicks failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Merge an adjacent span of tokens ([from, to] inclusive, in /analysis order)
 * on a cue into a single token. Returns the new token list. The caller should
 * re-fetch /analysis to pick up status for the merged word.
 */
export async function mergeTokens(
  sid: string,
  cueIndex: number,
  from: number,
  to: number,
): Promise<{ ok: boolean; tokens: Array<{ surface: string; lemma: string; reading: string; content: boolean }> }> {
  const res = await fetch(`${BASE}/session/${sid}/card/${cueIndex}/mergeTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) throw new Error(`mergeTokens failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function removePick(sid: string, pickId: string): Promise<{
  pileCount: number;
  /** Lemmas whose known-store status changed (null = entry removed → reverts to 'new'). */
  statusChanges: Record<string, WordStatus | null>;
}> {
  const res = await fetch(`${BASE}/session/${sid}/pick/${encodeURIComponent(pickId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`removePick failed: ${res.status}`);
  return res.json();
}

export async function freeSpace(sid: string): Promise<{ freedBytes: number }> {
  const res = await fetch(`${BASE}/session/${sid}/free-space`, { method: 'POST' });
  if (!res.ok) throw new Error(`freeSpace failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export type RelinkResult = {
  ok: boolean;
  mismatch: boolean;
  expectedDurationMs: number | null;
  actualDurationMs: number;
};

export async function relinkVideo(sid: string, file: File): Promise<RelinkResult> {
  const fd = new FormData();
  fd.append('video', file, file.name);
  const res = await fetch(`${BASE}/session/${sid}/relink`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`relink failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function relinkYoutube(sid: string, onEvent: SseHandler): Promise<void> {
  await streamSse(`/session/${sid}/relink-youtube`, { method: 'POST' }, onEvent);
}

export type CardEdit = {
  text?: string;
  translation?: string;
  note?: string;
};

export async function updateCard(
  sid: string,
  index: number,
  edit: CardEdit,
): Promise<{ index: number; text: string; translation?: string; note?: string }> {
  const res = await fetch(`${BASE}/session/${sid}/card/${index}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(edit),
  });
  if (!res.ok) throw new Error(`updateCard failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.card;
}

export function mediaUrl(path: string): string {
  return `${BASE}${path}`;
}

export async function mergeWithPrevious(
  sid: string,
  cardIndex: number,
): Promise<{ mergedCardIndex: number; newPosition: number; totalCards: number }> {
  const res = await fetch(`${BASE}/session/${sid}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cardIndex }),
  });
  if (!res.ok) throw new Error(`merge failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type EditProposal = {
  text?: string;
  translation?: string;
  note?: string;
};

export async function streamChat(
  sid: string,
  payload: {
    index: number;
    messages: ChatMessage[];
    openrouterKey: string;
    model: string;
  },
  onEvent: SseHandler,
): Promise<void> {
  await streamSse(
    `/session/${sid}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    onEvent,
  );
}

export type WordStatus = 'known' | 'learning' | 'created' | 'ignored';
export type TokenStatus = WordStatus | 'new';
/** Statuses settable from the review-view hotkeys (1/0). */
export type ManualWordStatus = 'known' | 'ignored';

export async function markWord(
  lemma: string,
  status: ManualWordStatus | null,
  reading?: string,
): Promise<{ ok: boolean; lemma: string; status: WordStatus | null }> {
  const res = await fetch(`${BASE}/known/mark`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lemma, status, reading }),
  });
  if (!res.ok) throw new Error(`markWord failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export type CardAnalysis = {
  newCount: number;
  learningCount: number;
  knownCount: number;
  createdCount: number;
  tokens: Array<{ t: string; s?: TokenStatus; lemma?: string; reading?: string }>;
};

export async function fetchAnalysis(sid: string): Promise<Record<number, CardAnalysis>> {
  const res = await fetch(`${BASE}/session/${sid}/analysis`);
  if (!res.ok) throw new Error(`fetchAnalysis: ${res.status}`);
  const data = await res.json();
  return data.words as Record<number, CardAnalysis>;
}

export type KnownSummary = {
  total: number;
  known: number;
  learning: number;
  created: number;
  updatedAt: number;
  source?: string;
};

export async function fetchKnownSummary(): Promise<KnownSummary> {
  const res = await fetch(`${BASE}/known`);
  if (!res.ok) throw new Error(`fetchKnownSummary: ${res.status}`);
  return res.json();
}

export type KnownWord = {
  word: string;
  status: WordStatus;
  reading: string;
  intervalDays: number;
};

export async function fetchKnownWords(): Promise<KnownWord[]> {
  const res = await fetch(`${BASE}/known/words`);
  if (!res.ok) throw new Error(`fetchKnownWords: ${res.status}`);
  const data = await res.json();
  return data.words as KnownWord[];
}

export type KnownSnapshot = {
  date: string;
  known: number;
  learning: number;
  created: number;
  total: number;
};

export async function fetchKnownHistory(): Promise<KnownSnapshot[]> {
  const res = await fetch(`${BASE}/known/history`);
  if (!res.ok) throw new Error(`fetchKnownHistory: ${res.status}`);
  const data = await res.json();
  return data.history as KnownSnapshot[];
}

export async function fetchAnkiDecks(url?: string): Promise<string[]> {
  const q = url ? `?url=${encodeURIComponent(url)}` : '';
  const res = await fetch(`${BASE}/known/decks${q}`);
  if (!res.ok) throw new Error(`fetchAnkiDecks failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.decks as string[];
}

export type SyncKnownPayload = {
  decks: string[];
  field: string;
  knownThresholdDays?: number;
  url?: string;
};

export async function syncKnown(payload: SyncKnownPayload): Promise<KnownSummary> {
  const res = await fetch(`${BASE}/known/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`syncKnown failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function importKnown(text: string): Promise<KnownSummary> {
  const res = await fetch(`${BASE}/known/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`importKnown failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function clearKnown(): Promise<KnownSummary> {
  const res = await fetch(`${BASE}/known`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearKnown failed: ${res.status}`);
  return res.json();
}

export type SseHandler = (event: { event: string; data: unknown }) => void;

export async function streamSse(
  url: string,
  init: RequestInit,
  onEvent: SseHandler,
): Promise<void> {
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`SSE failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const ev: { event: string; data: unknown } = { event: 'message', data: null };
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) ev.event = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
          try {
            ev.data = JSON.parse(line.slice(6));
          } catch {
            ev.data = line.slice(6);
          }
        }
      }
      onEvent(ev);
    }
  }
}
