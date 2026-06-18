import path from 'node:path';
import { createRequire } from 'node:module';
import kuromoji from 'kuromoji';

const require = createRequire(import.meta.url);

export type Token = {
  surface: string;
  /** Dictionary (base) form — what we match against the known-words list. */
  lemma: string;
  /** Hiragana reading, when the dictionary knows one. */
  reading: string;
  /** Whether this is a content word worth counting (noun/verb/adj/adverb). */
  content: boolean;
};

function kataToHira(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

let tokenizerPromise: Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> | null = null;

// Build once (loads the IPADIC dictionary shipped with kuromoji) and reuse.
function getTokenizer(): Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> {
  if (!tokenizerPromise) {
    const dicPath = path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict');
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, tk) => (err ? reject(err) : resolve(tk)));
    });
  }
  return tokenizerPromise;
}

// Parts-of-speech that count as 'content' words worth surfacing in the review
// UI and matching against known-words. 連体詞 catches interrogatives and
// demonstratives (どういう, この, その, あらゆる, …) — common enough to be worth
// being clickable; the user can mark uninteresting ones as ignored with `0`.
const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞']);
// 非自立 (non-independent) nouns like ふう / こと / ところ ARE meaningful content
// for a learner — keep them. 代名詞 (彼 / 私 / 君) too. Bare numbers (数) stay
// excluded because they aren't useful vocab; numbers fused with their counter
// suffix (4月, 3時) are re-included via the merger below.
const EXCLUDE_DETAIL = new Set(['数']);
const HAS_JAPANESE = /[぀-ヿ一-鿿]/;

// IPADIC POS tags for tokens that attach to a preceding verb/adjective stem.
// kuromoji frequently splits 食べる → 食べ + る; 大きかった → 大きかっ + た; etc.
// We re-glue these so the user clicks ONE token whose lemma is the dictionary form.
const MERGE_INTO_PREV_POS = new Set(['助動詞']);
const MERGE_INTO_PREV_DETAIL = new Set(['非自立', '接尾']);

function shouldMergeIntoPrev(
  prev: kuromoji.IpadicFeatures,
  next: kuromoji.IpadicFeatures,
): boolean {
  if (prev.pos === '動詞' || prev.pos === '形容詞') {
    if (MERGE_INTO_PREV_POS.has(next.pos)) return true;
    if (
      (next.pos === '動詞' || next.pos === '形容詞') &&
      MERGE_INTO_PREV_DETAIL.has(next.pos_detail_1)
    ) {
      return true;
    }
  }
  // Counters: 4 + 月 / 3 + 時 / 5 + 人 — re-glue into one noun.
  if (
    prev.pos === '名詞' &&
    prev.pos_detail_1 === '数' &&
    next.pos === '名詞' &&
    next.pos_detail_1 === '接尾'
  ) {
    return true;
  }
  return false;
}

function joinFeature(value: string | undefined, raw: string | undefined): string {
  if (!raw || raw === '*') return value ?? '';
  if (!value) return raw;
  return value + raw;
}

function mergeAuxiliaries(tokens: kuromoji.IpadicFeatures[]): kuromoji.IpadicFeatures[] {
  if (tokens.length < 2) return tokens;
  const out: kuromoji.IpadicFeatures[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev && shouldMergeIntoPrev(prev, t)) {
      const surface = prev.surface_form + t.surface_form;
      const numberCounter =
        prev.pos === '名詞' && prev.pos_detail_1 === '数' && t.pos_detail_1 === '接尾';
      out[out.length - 1] = {
        ...prev,
        surface_form: surface,
        // Counters: the merged form is the dictionary form (4月 IS the lemma),
        // and we promote pos_detail_1 to '一般' so the content filter accepts it.
        pos_detail_1: numberCounter ? '一般' : prev.pos_detail_1,
        basic_form: numberCounter ? surface : prev.basic_form,
        reading: joinFeature(
          prev.reading && prev.reading !== '*' ? prev.reading : '',
          t.reading,
        ) || '*',
        pronunciation: joinFeature(
          prev.pronunciation && prev.pronunciation !== '*' ? prev.pronunciation : '',
          t.pronunciation,
        ) || '*',
      };
    } else {
      out.push(t);
    }
  }
  return out;
}

export async function tokenize(text: string): Promise<Token[]> {
  const tk = await getTokenizer();
  const raw = mergeAuxiliaries(tk.tokenize(text));
  return raw.map((t) => {
    const lemma = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
    const content =
      CONTENT_POS.has(t.pos) &&
      !EXCLUDE_DETAIL.has(t.pos_detail_1) &&
      HAS_JAPANESE.test(t.surface_form);
    const reading = t.reading && t.reading !== '*' ? kataToHira(t.reading) : '';
    return { surface: t.surface_form, lemma, reading, content };
  });
}
