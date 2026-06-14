export type VocabEntry = {
  word: string;
  reading: string;
  gloss: string;
  isTarget?: boolean;
};

export type GrammarEntry = {
  pattern: string;
  explanation: string;
};

export type Enrichment = {
  translation: string;
  vocabulary: VocabEntry[];
  grammar: GrammarEntry[];
};

const SCHEMA = {
  type: 'object',
  properties: {
    translation: {
      type: 'string',
      description: 'Natural English translation of the sentence.',
    },
    vocabulary: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          word: { type: 'string', description: 'Dictionary form of the word in Japanese.' },
          reading: { type: 'string', description: 'Hiragana reading of the word.' },
          gloss: { type: 'string', description: 'Short English gloss.' },
          isTarget: {
            type: 'boolean',
            description: 'true if this is the most notable / target word.',
          },
        },
        required: ['word', 'reading', 'gloss'],
        additionalProperties: false,
      },
    },
    grammar: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Grammar pattern, e.g. 〜てから.' },
          explanation: {
            type: 'string',
            description: 'One short paragraph explaining the pattern in context.',
          },
        },
        required: ['pattern', 'explanation'],
        additionalProperties: false,
      },
    },
  },
  required: ['translation', 'vocabulary', 'grammar'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a Japanese language tutor producing flashcard annotations.
Given a single Japanese sentence taken from anime dialogue, return:
- a natural English translation,
- 1 to 4 vocabulary entries covering the most useful words (skip particles and trivial words),
- 0 to 2 grammar notes for notable patterns or constructions.
For vocabulary, give the dictionary form and a short gloss. Pick at most one item as "isTarget" — the word a learner would most want to study.
Be concise. Return JSON that matches the schema.`;

type ChatResponse = {
  choices: Array<{
    message: {
      content?: string | null;
      refusal?: string | null;
    };
  }>;
};

export type EnrichOptions = {
  apiKey: string;
  model: string;
  referer?: string;
  appName?: string;
};

export async function enrichSentence(sentence: string, opts: EnrichOptions): Promise<Enrichment> {
  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: sentence },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'card_enrichment', strict: true, schema: SCHEMA },
    },
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
      'HTTP-Referer': opts.referer ?? 'http://localhost:5173',
      'X-Title': opts.appName ?? 'Anki Studio',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openrouter ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as ChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('openrouter returned empty content');

  const parsed = JSON.parse(content) as Enrichment;
  return {
    translation: parsed.translation ?? '',
    vocabulary: Array.isArray(parsed.vocabulary) ? parsed.vocabulary : [],
    grammar: Array.isArray(parsed.grammar) ? parsed.grammar : [],
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function vocabularyToHtml(items: VocabEntry[]): string {
  if (!items.length) return '';
  return items
    .map((v) => {
      const cls = v.isTarget ? 'js-vocab-item js-vocab-item--target' : 'js-vocab-item';
      return `<div class="${cls}"><span class="js-vocab-item__head">${escapeHtml(v.word)}</span><span class="js-vocab-item__reading">${escapeHtml(v.reading)}</span><span class="js-vocab-item__gloss">${escapeHtml(v.gloss)}</span></div>`;
    })
    .join('');
}

const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: { type: 'string' },
      description: 'English translations, one per input sentence, in the same order.',
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

const TRANSLATE_SYSTEM = `You translate Japanese anime subtitles into natural English.
You receive the full transcript as a numbered list. Use the surrounding sentences as context
to disambiguate pronouns, register and references, but return ONE translation per numbered
sentence. Return JSON matching the schema: translations[i] corresponds to sentence i+1.
Keep translations concise and natural; preserve any named entities and proper nouns.`;

export async function translateBatch(
  sentences: string[],
  opts: EnrichOptions,
): Promise<string[]> {
  if (sentences.length === 0) return [];

  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM },
      { role: 'user', content: numbered },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'transcript_translation', strict: true, schema: TRANSLATE_SCHEMA },
    },
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
      'HTTP-Referer': opts.referer ?? 'http://localhost:5173',
      'X-Title': opts.appName ?? 'Anki Studio',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`openrouter ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as ChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('openrouter returned empty content');

  const parsed = JSON.parse(content) as { translations?: string[] };
  const out = Array.isArray(parsed.translations) ? parsed.translations : [];
  // Pad / truncate to match input length so callers can rely on indices.
  if (out.length < sentences.length) {
    while (out.length < sentences.length) out.push('');
  } else if (out.length > sentences.length) {
    out.length = sentences.length;
  }
  return out;
}

export function grammarToHtml(items: GrammarEntry[]): string {
  if (!items.length) return '';
  return items
    .map(
      (g) =>
        `<div class="js-grammar__entry"><div class="js-grammar__title">${escapeHtml(g.pattern)}</div><div class="js-grammar__body">${escapeHtml(g.explanation)}</div></div>`,
    )
    .join('');
}
