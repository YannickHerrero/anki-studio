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

const VOCAB_PROP = {
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
} as const;

const GRAMMAR_PROP = {
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
} as const;

const SCHEMA_FULL = {
  type: 'object',
  properties: {
    translation: {
      type: 'string',
      description: 'Natural English translation of the sentence.',
    },
    vocabulary: VOCAB_PROP,
    grammar: GRAMMAR_PROP,
  },
  required: ['translation', 'vocabulary', 'grammar'],
  additionalProperties: false,
};

const SCHEMA_NO_TRANSLATION = {
  type: 'object',
  properties: {
    vocabulary: VOCAB_PROP,
    grammar: GRAMMAR_PROP,
  },
  required: ['vocabulary', 'grammar'],
  additionalProperties: false,
};

const SYSTEM_FULL = `You are a Japanese language tutor producing flashcard annotations.
Given a single Japanese sentence taken from anime dialogue, return:
- a natural English translation,
- 1 to 4 vocabulary entries covering the most useful words (skip particles and trivial words),
- 0 to 2 grammar notes for notable patterns or constructions.
For vocabulary, give the dictionary form and a short gloss. Pick at most one item as "isTarget" — the word a learner would most want to study.
Be concise. Return JSON that matches the schema.`;

const SYSTEM_NO_TRANSLATION = `You are a Japanese language tutor producing flashcard annotations.
You will be given a Japanese sentence and its existing English translation.
Return only:
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

export type EnrichInput =
  | { sentence: string; existingTranslation?: undefined }
  | { sentence: string; existingTranslation: string };

export async function enrichSentence(input: EnrichInput, opts: EnrichOptions): Promise<Enrichment> {
  const useExisting = !!input.existingTranslation;
  const userContent = useExisting
    ? `Sentence: ${input.sentence}\nExisting translation: ${input.existingTranslation}`
    : input.sentence;

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: useExisting ? SYSTEM_NO_TRANSLATION : SYSTEM_FULL },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'card_enrichment',
        strict: true,
        schema: useExisting ? SCHEMA_NO_TRANSLATION : SCHEMA_FULL,
      },
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

  const parsed = JSON.parse(content) as Partial<Enrichment>;
  return {
    translation: useExisting ? input.existingTranslation : parsed.translation ?? '',
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
