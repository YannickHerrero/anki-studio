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

// ----- Word-details enrichment for vocab cards -----

export type WordItem = {
  lemma: string;
  surface: string;
  sentence: string;
};

export type WordDetailsOut = {
  definition: string;
  reading: string;
  pitchPattern?: string;
  frequency?: string;
  partOfSpeech?: string;
  usageNotes?: string;
};

const WORD_DETAILS_SCHEMA = {
  type: 'object',
  properties: {
    details: {
      type: 'array',
      description: 'One entry per input word, in the same order.',
      items: {
        type: 'object',
        properties: {
          definition: {
            type: 'string',
            description:
              "A short context-aware English definition (1-2 lines) for how the word is used in the given sentence. Don't list every sense.",
          },
          reading: {
            type: 'string',
            description: 'Hiragana reading of the dictionary form (lemma).',
          },
          pitchPattern: {
            type: 'string',
            description:
              "Tokyo pitch accent in bracketed-number form (e.g. '[2]', '[0]'). Empty string if unknown.",
          },
          frequency: {
            type: 'string',
            description: "One of: 'very common', 'common', 'uncommon', 'rare'.",
          },
          partOfSpeech: {
            type: 'string',
            description: "Short label like 'Ichidan verb', 'い-adjective', 'noun', 'adverb'.",
          },
          usageNotes: {
            type: 'string',
            description:
              "One short sentence (or empty) about how the word behaves — collocations, register, common particles, etc.",
          },
        },
        required: [
          'definition',
          'reading',
          'pitchPattern',
          'frequency',
          'partOfSpeech',
          'usageNotes',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['details'],
  additionalProperties: false,
};

const WORD_DETAILS_SYSTEM = `You produce flashcard annotations for one Japanese word at a time.
You receive a numbered list of items, each with the dictionary form (lemma), the
surface form as seen in the sentence, and the sentence the word appears in.
For each item return ONE entry with: a short context-aware definition (1-2 lines,
matching the meaning used in that sentence — not every sense of the word), the
hiragana reading of the lemma, the Tokyo pitch accent (bracketed-number form like
'[2]' or empty string if unknown), a frequency label ('very common', 'common',
'uncommon', 'rare'), a short part-of-speech label, and a brief usage note (or empty
string). The output array must have the same length and order as the input list.`;

/**
 * Enrich a batch of target words with context-aware details. One OpenRouter call.
 * Order of the output array matches the order of the input array; missing entries
 * are padded with placeholders so downstream code can index by position.
 */
export async function enrichWordBatch(
  items: WordItem[],
  opts: EnrichOptions,
): Promise<WordDetailsOut[]> {
  if (items.length === 0) return [];

  const numbered = items
    .map(
      (it, i) =>
        `${i + 1}. lemma=${it.lemma}; surface=${it.surface}; sentence=${it.sentence}`,
    )
    .join('\n');

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: WORD_DETAILS_SYSTEM },
      { role: 'user', content: numbered },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'word_details_batch', strict: true, schema: WORD_DETAILS_SCHEMA },
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

  const parsed = JSON.parse(content) as { details?: WordDetailsOut[] };
  const out = Array.isArray(parsed.details) ? parsed.details : [];
  while (out.length < items.length) {
    out.push({
      definition: '',
      reading: '',
      pitchPattern: '',
      frequency: '',
      partOfSpeech: '',
      usageNotes: '',
    });
  }
  if (out.length > items.length) out.length = items.length;
  return out;
}

export function wordDetailsToHtml(details: WordDetailsOut): string {
  if (!details.definition && !details.reading) return '';
  const meta: string[] = [];
  if (details.reading) meta.push(escapeHtml(details.reading));
  if (details.pitchPattern) meta.push(escapeHtml(details.pitchPattern));
  if (details.partOfSpeech) meta.push(escapeHtml(details.partOfSpeech));
  if (details.frequency) meta.push(escapeHtml(details.frequency));
  const metaHtml = meta.length
    ? `<div class="js-word-meta">${meta.map((m) => `<span>${m}</span>`).join('<span class="js-word-meta__sep">·</span>')}</div>`
    : '';
  const usageHtml = details.usageNotes
    ? `<div class="js-word-usage">${escapeHtml(details.usageNotes)}</div>`
    : '';
  return `<div class="js-word">${metaHtml}<div class="js-word-def">${escapeHtml(details.definition)}</div>${usageHtml}</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----- LLM-refined tokenization -----

export type RefineTokenInput = {
  cueIndex: number;
  sentence: string;
  /** kuromoji's tokenization as a hint — array of `surface(pos)`. */
  kuromoji: Array<{ surface: string; pos: string; basic: string }>;
};

export type RefineTokenOut = {
  surface: string;
  lemma: string;
  reading: string;
  content: boolean;
};

const REFINE_TOKENS_SCHEMA = {
  type: 'object',
  properties: {
    cues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cueIndex: { type: 'integer' },
          tokens: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                surface: {
                  type: 'string',
                  description: 'Exact substring of the input sentence.',
                },
                lemma: {
                  type: 'string',
                  description:
                    'Dictionary form of the word. For particles / punctuation, copy surface.',
                },
                reading: {
                  type: 'string',
                  description: 'Hiragana reading of the lemma. Empty string if N/A.',
                },
                content: {
                  type: 'boolean',
                  description:
                    'true for nouns / verbs / adjectives / adverbs / proper nouns / counters that should be clickable as vocab; false for particles, auxiliaries, punctuation.',
                },
              },
              required: ['surface', 'lemma', 'reading', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['cueIndex', 'tokens'],
        additionalProperties: false,
      },
    },
  },
  required: ['cues'],
  additionalProperties: false,
};

const REFINE_TOKENS_SYSTEM = `You re-tokenize Japanese subtitle sentences into a sequence of meaningful units.

For each sentence:
- The concatenation of token surfaces MUST exactly equal the input sentence (no extra characters, no missing characters).
- Merge inflected verb / adjective forms into ONE token whose surface is the full conjugated form and lemma is the dictionary form. Examples: "食べました" → one token (lemma 食べる); "過ごしてました" → one token (lemma 過ごす); "大きかった" → one token (lemma 大きい).
- Merge counters with their numbers: "4月" / "3時" / "5人" / "10年" → one token whose lemma equals the surface.
- Keep proper nouns (names, places, brand names) as single tokens.
- Particles (は / を / が / と / に / で / の / も / よ / ね / か), punctuation, and auxiliaries that didn't merge into a verb are separate tokens with content=false.

You also receive kuromoji's tokenization as a hint. Use it as a starting point but correct over-segmentation, mis-tagged content, and missed proper-noun groupings. Do NOT invent words that aren't in the sentence.

Return JSON matching the schema. Order: same as input. cueIndex must match the input index for each entry.`;

/**
 * Re-tokenize a batch of cues via an LLM. Returns a Map from cueIndex to
 * RefineTokenOut[]. Cues whose response fails validation (surface
 * concatenation doesn't match the source sentence) are absent from the
 * returned Map — the caller should fall back to kuromoji for those.
 */
export async function refineTokenBatch(
  items: RefineTokenInput[],
  opts: EnrichOptions,
): Promise<Map<number, RefineTokenOut[]>> {
  const out = new Map<number, RefineTokenOut[]>();
  if (items.length === 0) return out;

  const numbered = items
    .map(
      (it) =>
        `cueIndex=${it.cueIndex}\nsentence=${it.sentence}\nkuromoji=${it.kuromoji
          .map((t) => `${t.surface}(${t.pos})`)
          .join(' ')}`,
    )
    .join('\n---\n');

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: REFINE_TOKENS_SYSTEM },
      { role: 'user', content: numbered },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'refined_tokens_batch', strict: true, schema: REFINE_TOKENS_SCHEMA },
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

  const parsed = JSON.parse(content) as {
    cues?: Array<{ cueIndex: number; tokens: RefineTokenOut[] }>;
  };
  const cues = Array.isArray(parsed.cues) ? parsed.cues : [];
  const sourceByIdx = new Map(items.map((i) => [i.cueIndex, i.sentence]));

  for (const entry of cues) {
    const source = sourceByIdx.get(entry.cueIndex);
    if (!source) continue;
    if (!Array.isArray(entry.tokens) || entry.tokens.length === 0) continue;
    const concat = entry.tokens.map((t) => t.surface ?? '').join('');
    if (concat !== source) continue; // Drop — model corrupted the surface.
    out.set(entry.cueIndex, entry.tokens);
  }

  return out;
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

const SPLIT_SCHEMA = {
  type: 'object',
  properties: {
    sentenceEndIndices: {
      type: 'array',
      items: { type: 'integer' },
      description:
        'Indices (0-based) of words that end a sentence in the input list. ' +
        'Always include the last word of the list as the final boundary.',
    },
  },
  required: ['sentenceEndIndices'],
  additionalProperties: false,
};

const SPLIT_SYSTEM = `You receive a numbered list of Japanese words from a transcript.
Decide where complete sentences end. Return ONLY the 0-based indices of the words
that are the LAST word of each sentence.
Treat each clause-final 「ね」「よ」「か」+ pause, sentence-final particles, full stops,
and natural ends as sentence boundaries. Do NOT rewrite the text — only choose indices.
The last index in the input must always be included as a final boundary.`;

export async function refineSentenceBoundaries(
  words: { word: string }[],
  opts: EnrichOptions,
): Promise<number[]> {
  if (words.length === 0) return [];

  const numbered = words.map((w, i) => `${i}. ${w.word}`).join('\n');

  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: SPLIT_SYSTEM },
      { role: 'user', content: numbered },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'sentence_splits', strict: true, schema: SPLIT_SCHEMA },
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

  const parsed = JSON.parse(content) as { sentenceEndIndices?: number[] };
  return Array.isArray(parsed.sentenceEndIndices) ? parsed.sentenceEndIndices : [];
}

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
