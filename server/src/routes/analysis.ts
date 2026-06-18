import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/session.js';
import { tokenize } from '../lib/tokenizer.js';
import { loadKnown, type WordStatus } from '../lib/knownWords.js';
import { stripFurigana } from '../lib/furigana.js';

type TokenOut = { t: string; s?: WordStatus | 'new' };
type CardAnalysis = {
  newCount: number;
  learningCount: number;
  knownCount: number;
  createdCount: number;
  tokens: TokenOut[];
};

/**
 * Tokenize every card and tag each content word against the known-words list.
 * Lets the review UI show "N new words", highlight them, and filter by them.
 */
export async function analysisRoutes(app: FastifyInstance) {
  app.get('/session/:sid/analysis', async (req) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);
    const known = await loadKnown();

    const words: Record<number, CardAnalysis> = {};
    for (const card of session.cards) {
      const tokens = await tokenize(stripFurigana(card.text));
      const out: TokenOut[] = [];
      const seen: Record<'new' | WordStatus, Set<string>> = {
        new: new Set(),
        known: new Set(),
        learning: new Set(),
        created: new Set(),
      };
      for (const tok of tokens) {
        if (!tok.content) {
          out.push({ t: tok.surface });
          continue;
        }
        const status: WordStatus | 'new' = known.words[tok.lemma]?.status ?? 'new';
        seen[status].add(tok.lemma);
        out.push({ t: tok.surface, s: status });
      }
      words[card.index] = {
        newCount: seen.new.size,
        learningCount: seen.learning.size,
        knownCount: seen.known.size,
        createdCount: seen.created.size,
        tokens: out,
      };
    }

    return { words };
  });
}
