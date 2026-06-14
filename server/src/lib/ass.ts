export type RawAssCue = {
  startMs: number;
  endMs: number;
  text: string;
};

function parseAssTime(s: string): number | null {
  // Format: H:MM:SS.cs (cs = centiseconds, 2 digits)
  const m = s.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,3})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  // .NN is centiseconds; pad to ms.
  const fracStr = m[4]!.padEnd(3, '0').slice(0, 3);
  const ms = Number(fracStr);
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

const OVERRIDE_RE = /\{[^}]*\}/g;
const LINEBREAK_RE = /\\[Nnh]/g;

export function cleanAssText(raw: string): string {
  return raw
    .replace(OVERRIDE_RE, '')
    .replace(LINEBREAK_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAss(content: string): RawAssCue[] {
  const lines = content.split(/\r?\n/);
  let inEvents = false;
  let format: string[] | null = null;
  const cues: RawAssCue[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('[')) {
      inEvents = /^\[events\]/i.test(line);
      format = null;
      continue;
    }
    if (!inEvents) continue;

    if (/^format\s*:/i.test(line)) {
      format = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((s) => s.trim().toLowerCase());
      continue;
    }

    if (!/^dialogue\s*:/i.test(line)) continue;
    if (!format) continue;

    const body = line.slice(line.indexOf(':') + 1);
    // Text is the LAST field; previous fields are simple atoms separated by commas.
    const fieldCount = format.length;
    const parts: string[] = [];
    let cursor = 0;
    for (let i = 0; i < fieldCount - 1; i++) {
      const nextComma = body.indexOf(',', cursor);
      if (nextComma < 0) {
        parts.length = 0;
        break;
      }
      parts.push(body.slice(cursor, nextComma));
      cursor = nextComma + 1;
    }
    if (parts.length === 0) continue;
    parts.push(body.slice(cursor));

    const get = (name: string): string | undefined => {
      const idx = format!.indexOf(name);
      return idx >= 0 ? parts[idx] : undefined;
    };

    const start = parseAssTime(get('start') ?? '');
    const end = parseAssTime(get('end') ?? '');
    const text = cleanAssText(get('text') ?? '');
    if (start == null || end == null || end <= start || !text) continue;
    cues.push({ startMs: start, endMs: end, text });
  }

  return cues;
}
