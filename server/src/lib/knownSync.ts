import { findCards, cardsInfo, type AnkiCardInfo } from './ankiconnect.js';
import { tokenize } from './tokenizer.js';
import { stripFurigana } from './furigana.js';
import type { KnownStore, KnownEntry, WordStatus } from './knownWords.js';

export type SyncOptions = {
  /** Deck names to pull from — sentence or vocabulary cards both work. */
  decks: string[];
  /** Note field holding the sentence (or word). Its text is tokenized. */
  field: string;
  /** Interval (days) at/above which a reviewed card counts as "known". */
  knownThresholdDays?: number;
  url?: string;
};

const RANK: Record<WordStatus, number> = { created: 0, learning: 1, known: 2 };

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// Status from a card's review state. Interval is the current spacing in days;
// a reviewed card spaced past the threshold is "known", anything still being
// learned is "learning", and a card never reviewed is just "created".
function classify(card: AnkiCardInfo, thresholdDays: number): WordStatus {
  if (card.reps === 0 || card.type === 0) return 'created';
  if (card.type === 2 && card.interval > thresholdDays) return 'known';
  return 'learning';
}

export async function buildKnownFromAnki(opts: SyncOptions): Promise<KnownStore> {
  const threshold = opts.knownThresholdDays ?? 10;
  const words: Record<string, KnownEntry> = {};

  for (const deck of opts.decks) {
    const ids = await findCards(`deck:"${deck.replace(/"/g, '\\"')}"`, opts.url);
    const infos = await cardsInfo(ids, opts.url);
    for (const card of infos) {
      const text = stripFurigana(stripHtml(card.fields[opts.field]?.value ?? ''));
      if (!text) continue;
      const status = classify(card, threshold);
      // Every content word in a sentence card inherits that card's status, so a
      // sentence you've matured marks all its words known.
      const tokens = await tokenize(text);
      for (const tok of tokens) {
        if (!tok.content) continue;
        const existing = words[tok.lemma];
        // A word appears in many sentences; the most mature card wins.
        if (!existing || RANK[status] > RANK[existing.status]) {
          words[tok.lemma] = {
            status,
            intervalDays: card.interval,
            reading: tok.reading || existing?.reading,
          };
        } else {
          if (card.interval > (existing.intervalDays ?? 0)) existing.intervalDays = card.interval;
          if (tok.reading && !existing.reading) existing.reading = tok.reading;
        }
      }
    }
  }

  return { updatedAt: Date.now(), source: 'ankiconnect', words };
}
