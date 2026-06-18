import path from 'node:path';
import { createRequire } from 'node:module';
import kuromoji from 'kuromoji';

const require = createRequire(import.meta.url);

export type Token = {
  surface: string;
  /** Dictionary (base) form — what we match against the known-words list. */
  lemma: string;
  /** Whether this is a content word worth counting (noun/verb/adj/adverb). */
  content: boolean;
};

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

const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '副詞']);
const EXCLUDE_DETAIL = new Set(['非自立', '代名詞', '数', '接尾']);
const HAS_JAPANESE = /[぀-ヿ一-鿿]/;

export async function tokenize(text: string): Promise<Token[]> {
  const tk = await getTokenizer();
  return tk.tokenize(text).map((t) => {
    const lemma = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
    const content =
      CONTENT_POS.has(t.pos) &&
      !EXCLUDE_DETAIL.has(t.pos_detail_1) &&
      HAS_JAPANESE.test(t.surface_form);
    return { surface: t.surface_form, lemma, content };
  });
}
