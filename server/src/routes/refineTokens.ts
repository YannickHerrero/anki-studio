import path from 'node:path';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import kuromoji from 'kuromoji';
import { requireSession } from '../lib/session.js';
import { refineTokenBatch, type RefineTokenInput } from '../lib/openrouter.js';
import { stripFurigana } from '../lib/furigana.js';
import { persistSession } from '../lib/persistence.js';

type Body = {
  openrouterKey?: string;
  model?: string;
  batchSize?: number;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const requireFn = createRequire(import.meta.url);
let kuromojiPromise: Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> | null = null;
function getKuromoji(): Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> {
  if (!kuromojiPromise) {
    const dicPath = path.join(
      path.dirname(requireFn.resolve('kuromoji/package.json')),
      'dict',
    );
    kuromojiPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err, tk) => (err ? reject(err) : resolve(tk)));
    });
  }
  return kuromojiPromise;
}

export async function refineTokensRoutes(app: FastifyInstance) {
  app.post('/session/:sid/refineTokens', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as Body | undefined) ?? {};
    const session = requireSession(sid);

    if (!body.openrouterKey || !body.model) {
      return reply.code(400).send({ error: 'openrouterKey and model are required' });
    }
    if (session.cues.length === 0) {
      return reply.code(400).send({ error: 'no cues to refine' });
    }

    const batchSize = Math.max(1, Math.min(50, body.batchSize ?? 20));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', { total: session.cues.length, batchSize });
      const tk = await getKuromoji();

      let refinedCount = 0;
      let failedCount = 0;
      for (let i = 0; i < session.cues.length; i += batchSize) {
        const slice = session.cues.slice(i, i + batchSize);

        const items: RefineTokenInput[] = slice.map((c) => {
          const sentence = stripFurigana(c.text);
          const raw = tk.tokenize(sentence);
          return {
            cueIndex: c.index,
            sentence,
            kuromoji: raw.map((t) => ({
              surface: t.surface_form,
              pos: `${t.pos}-${t.pos_detail_1}`,
              basic: t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form,
            })),
          };
        });

        let map;
        try {
          map = await refineTokenBatch(items, {
            apiKey: body.openrouterKey,
            model: body.model,
          });
        } catch (err) {
          // A whole batch failing is non-fatal — fall back to kuromoji for these.
          failedCount += slice.length;
          write('progress', {
            done: Math.min(i + batchSize, session.cues.length),
            total: session.cues.length,
            refined: refinedCount,
            failed: failedCount,
          });
          continue;
        }

        for (const cue of slice) {
          const tokens = map.get(cue.index);
          if (tokens && tokens.length > 0) {
            cue.refinedTokens = tokens;
            refinedCount++;
          } else {
            failedCount++;
          }
        }

        persistSession(session);
        write('progress', {
          done: Math.min(i + batchSize, session.cues.length),
          total: session.cues.length,
          refined: refinedCount,
          failed: failedCount,
        });
      }

      persistSession(session, { immediate: true });
      write('done', { refined: refinedCount, failed: failedCount });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });
}
