import path from 'node:path';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import kuromoji from 'kuromoji';
import { requireSession, type Cue } from '../lib/session.js';
import { refineTokenBatch, type RefineTokenInput } from '../lib/openrouter.js';
import { stripFurigana } from '../lib/furigana.js';
import { persistSession } from '../lib/persistence.js';
import { mapWithConcurrency } from '../lib/pool.js';

type Body = {
  openrouterKey?: string;
  model?: string;
  batchSize?: number;
  /** Max number of batches in flight at once. Default 5. */
  concurrency?: number;
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
    // Pull into locals so the closure below isn't widened by TS.
    const apiKey = body.openrouterKey;
    const model = body.model;

    const batchSize = Math.max(1, Math.min(50, body.batchSize ?? 20));
    const concurrency = Math.max(1, Math.min(20, body.concurrency ?? 5));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', { total: session.cues.length, batchSize, concurrency });
      const tk = await getKuromoji();

      // Build all batches up-front so we can fan them out in parallel.
      const batches: Cue[][] = [];
      for (let i = 0; i < session.cues.length; i += batchSize) {
        batches.push(session.cues.slice(i, i + batchSize));
      }

      let refinedCount = 0;
      let failedCount = 0;
      let cuesProcessed = 0;
      const totalCues = session.cues.length;

      await mapWithConcurrency(batches, concurrency, async (slice) => {
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
          map = await refineTokenBatch(items, { apiKey, model });
        } catch (err) {
          failedCount += slice.length;
          cuesProcessed += slice.length;
          write('progress', {
            done: cuesProcessed,
            total: totalCues,
            refined: refinedCount,
            failed: failedCount,
          });
          return;
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

        cuesProcessed += slice.length;
        persistSession(session); // debounced
        write('progress', {
          done: cuesProcessed,
          total: totalCues,
          refined: refinedCount,
          failed: failedCount,
        });
      });

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
