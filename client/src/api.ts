export type CardSummary = {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  audioUrl: string;
  screenshotUrl: string;
  audioReady: boolean;
  screenshotReady: boolean;
};

export type Decision = 'keep' | 'skip';

const BASE = '/api';

export async function upload(video: File, subtitle: File): Promise<{
  sessionId: string;
  cueCount: number;
}> {
  const fd = new FormData();
  fd.append('video', video, video.name);
  fd.append('subtitle', subtitle, subtitle.name);
  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return res.json();
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
