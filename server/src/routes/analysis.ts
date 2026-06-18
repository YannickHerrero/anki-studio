import type { FastifyInstance } from 'fastify';
import { requireSession } from '../lib/session.js';
import { tokenize } from '../lib/tokenizer.js';
import { loadKnown, type WordStatus } from '../lib/knownWords.js';
import { stripFurigana } from '../lib/furigana.js';

type TokenOut = {
  t: string;
  /** Status against the known list. Absent for non-content tokens (particles, punctuation). */
  s?: WordStatus | 'new';
  /** Dictionary form. Absent for non-content tokens. */
  lemma?: string;
  /** Hiragana reading of the lemma. Absent for non-content tokens. */
  reading?: string;
};
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
    for (const cue of session.cues) {
      // Use LLM-refined tokens if available; otherwise tokenize with kuromoji.
      const tokens = cue.refinedTokens
        ? cue.refinedTokens.map((t) => ({
            surface: t.surface,
            lemma: t.lemma,
            reading: t.reading,
            content: t.content,
          }))
        : await tokenize(stripFurigana(cue.text));
      const out: TokenOut[] = [];
      const seen: Record<'new' | WordStatus, Set<string>> = {
        new: new Set(),
        known: new Set(),
        learning: new Set(),
        created: new Set(),
        ignored: new Set(),
      };
      for (const tok of tokens) {
        if (!tok.content) {
          out.push({ t: tok.surface });
          continue;
        }
        const status: WordStatus | 'new' = known.words[tok.lemma]?.status ?? 'new';
        seen[status].add(tok.lemma);
        out.push({ t: tok.surface, s: status, lemma: tok.lemma, reading: tok.reading });
      }
      words[cue.index] = {
        // 'ignored' words contribute to NEITHER newCount NOR knownCount —
        // they're a "skip me" mark that just hides the underline.
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
