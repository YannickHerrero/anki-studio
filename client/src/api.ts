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
  exported: boolean;
};

export type Decision = 'keep' | 'skip';

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
};

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
  cards: CardSummary[];
  decisions: Record<number, Decision>;
}> {
  const res = await fetch(`${BASE}/session/${sid}/cards`);
  if (!res.ok) throw new Error(`fetchCards: ${res.status}`);
  return res.json();
}

export async function saveDecisions(
  sid: string,
  decisions: Record<number, Decision>,
): Promise<void> {
  await fetch(`${BASE}/session/${sid}/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisions }),
  });
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
