/**
 * Conversational refinement for a single subtitle line.
 *
 * The model can discuss the line freely (grammar questions, nuance, etc.) and,
 * when the user asks for a change, propose an edit by calling a tool. Tool calls
 * are surfaced to the client as "proposals" — nothing is written until the user
 * accepts one. Every tool only ever targets the current line.
 */

export type ChatRole = 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

export type TranscriptLine = {
  index: number;
  text: string;
  translation?: string;
};

export type ChatContext = {
  index: number;
  text: string;
  translation?: string;
  note?: string;
  transcript: TranscriptLine[];
};

/** A proposed edit to the current line, shown to the user before applying. */
export type EditProposal = {
  text?: string;
  translation?: string;
  note?: string;
};

export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'proposal'; tool: string; edit: EditProposal };

export type ChatOptions = {
  apiKey: string;
  model: string;
  referer?: string;
  appName?: string;
};

const SYSTEM = `You help a Japanese learner refine ONE subtitle line from an anime.

You can:
- Discuss the line: explain grammar, vocabulary, nuance, register, or answer questions.
- Propose changes by calling a tool. Never describe an edit in prose and expect it
  to be applied — always call the matching tool so the user gets an accept/reject prompt.

Rules:
- Only ever edit the CURRENT line. Never touch other lines.
- Use the surrounding transcript only as context to disambiguate names, pronouns,
  and references.
- For furigana, only annotate proper nouns or rare/non-obvious readings using Anki's
  "base[reading]" syntax, e.g. 田中[たなか]さん. Leave ordinary study vocabulary bare so
  the card still tests the learner. Return the FULL line text, annotations included.
- Keep replies concise.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'update_translation',
      description: 'Replace the English translation of the current line.',
      parameters: {
        type: 'object',
        properties: {
          translation: { type: 'string', description: 'The new English translation.' },
        },
        required: ['translation'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_note',
      description:
        'Replace the freeform note for the current line (extra context, puns, tone…).',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The new note text.' },
        },
        required: ['note'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_furigana',
      description:
        'Return the current Japanese line with furigana added on proper nouns / rare ' +
        'readings using Anki base[reading] syntax. Leave ordinary words bare.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The full line text with base[reading] annotations added.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_text',
      description: 'Replace the Japanese text of the current line (fix a transcription error).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The corrected Japanese line.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
] as const;

function buildContextMessage(ctx: ChatContext): string {
  const transcript = ctx.transcript
    .map((l) => {
      const marker = l.index === ctx.index ? ' <-- CURRENT LINE' : '';
      const tr = l.translation ? `  [${l.translation}]` : '';
      return `${l.index}. ${l.text}${tr}${marker}`;
    })
    .join('\n');

  return [
    'Full transcript (for context only):',
    transcript,
    '',
    'CURRENT LINE under discussion:',
    `Japanese: ${ctx.text}`,
    `Translation: ${ctx.translation ?? '(none)'}`,
    `Note: ${ctx.note ?? '(none)'}`,
  ].join('\n');
}

function proposalFromToolCall(name: string, args: Record<string, unknown>): EditProposal | null {
  switch (name) {
    case 'update_translation':
      return typeof args.translation === 'string' ? { translation: args.translation } : null;
    case 'update_note':
      return typeof args.note === 'string' ? { note: args.note } : null;
    case 'add_furigana':
    case 'update_text':
      return typeof args.text === 'string' ? { text: args.text } : null;
    default:
      return null;
  }
}

type ToolCallAccumulator = { name: string; args: string };

export async function streamSubtitleChat(
  messages: ChatMessage[],
  ctx: ChatContext,
  opts: ChatOptions,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const body = {
    model: opts.model,
    stream: true,
    tools: TOOLS,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildContextMessage(ctx) },
      ...messages,
    ],
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

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`openrouter ${res.status}: ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let buf = '';

  const handleData = (payload: string) => {
    if (payload === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = (parsed as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    }).choices?.[0]?.delta;
    if (!delta) return;

    if (delta.content) onEvent({ type: 'token', text: delta.content });

    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const acc = toolCalls.get(idx) ?? { name: '', args: '' };
      if (tc.function?.name) acc.name = tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      toolCalls.set(idx, acc);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data: ')) handleData(line.slice(6).trim());
    }
  }

  for (const acc of toolCalls.values()) {
    if (!acc.name) continue;
    let args: Record<string, unknown> = {};
    try {
      args = acc.args ? (JSON.parse(acc.args) as Record<string, unknown>) : {};
    } catch {
      continue;
    }
    const edit = proposalFromToolCall(acc.name, args);
    if (edit) onEvent({ type: 'proposal', tool: acc.name, edit });
  }
}
