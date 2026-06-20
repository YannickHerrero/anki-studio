import type { FastifyInstance } from 'fastify';
import { readAnkiAssets } from '../lib/ankiAssets.js';
import {
  createModel,
  modelNames,
  updateModelStyling,
  updateModelTemplates,
} from '../lib/ankiconnect.js';

type SyncBody = {
  /** AnkiConnect URL. Defaults to http://127.0.0.1:8765. */
  url?: string;
  /** Model name. Defaults to 'Japanese Vocab Card' (matches the .apkg exporter). */
  modelName?: string;
};

const DEFAULT_MODEL_NAME = 'Japanese Vocab Card';
const CARD_TEMPLATE_NAME = 'Vocab';

/**
 * Field set for the Japanese Vocab Card note type. Kept in sync with the
 * FIELDS constant in lib/apkg.ts — these two must match or .apkg-derived
 * cards and AnkiConnect-created cards will diverge.
 */
const FIELDS = [
  'TargetWord',
  'Sentence',
  'SentenceTranslation',
  'Audio',
  'Screenshot',
  'WordDetails',
  'Grammar',
  'Notes',
];

export async function ankiSyncRoutes(app: FastifyInstance) {
  /**
   * Push the shipped front.html / back.html / styling.css to a running Anki.
   * - If the model doesn't exist, creates it (fields + templates + css).
   * - If it exists, updates the templates + css *in place*. Fields are left
   *   alone so any manual additions the user made in Anki survive.
   */
  app.post('/anki/sync-model', async (req, reply) => {
    const body = (req.body as SyncBody | undefined) ?? {};
    const url = body.url?.trim() || undefined;
    const modelName = body.modelName?.trim() || DEFAULT_MODEL_NAME;

    let assets;
    try {
      assets = await readAnkiAssets();
    } catch (err) {
      return reply.code(500).send({
        error: `failed to read templates: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    try {
      const names = await modelNames(url);
      if (names.includes(modelName)) {
        await updateModelTemplates(
          {
            name: modelName,
            templates: {
              [CARD_TEMPLATE_NAME]: { Front: assets.front, Back: assets.back },
            },
          },
          url,
        );
        await updateModelStyling({ name: modelName, css: assets.css }, url);
        return { ok: true, action: 'updated', modelName };
      }

      await createModel(
        {
          modelName,
          inOrderFields: FIELDS,
          css: assets.css,
          cardTemplates: [
            { Name: CARD_TEMPLATE_NAME, Front: assets.front, Back: assets.back },
          ],
        },
        url,
      );
      return { ok: true, action: 'created', modelName };
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
