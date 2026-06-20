import type { FastifyInstance } from 'fastify';
import { readAnkiAssets } from '../lib/ankiAssets.js';
import {
  createModel,
  findNotes,
  modelFieldAdd,
  modelFieldNames,
  modelNames,
  notesInfo,
  updateModelStyling,
  updateModelTemplates,
  updateNoteFields,
} from '../lib/ankiconnect.js';
import { allSessions } from '../lib/session.js';

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
  'AudioDurationMs',
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
        // Add any fields we reference that the user's Anki model doesn't have
        // yet (e.g. when a new field like AudioDurationMs ships). Existing
        // fields — including any the user added manually — are left alone.
        const existing = new Set(await modelFieldNames(modelName, url));
        const added: string[] = [];
        for (const field of FIELDS) {
          if (existing.has(field)) continue;
          await modelFieldAdd({ modelName, fieldName: field }, url);
          added.push(field);
        }
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
        return { ok: true, action: 'updated', modelName, addedFields: added };
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

  /**
   * One-shot backfill: walk every note of the model and populate
   * AudioDurationMs by matching the [sound:as_<sidPrefix>_<cueIdx>.mp3]
   * filename back to the originating session+cue. Notes already populated
   * are skipped; notes whose session is no longer on disk are reported as
   * missing (re-export to recover).
   */
  app.post('/anki/backfill-durations', async (req, reply) => {
    const body = (req.body as SyncBody | undefined) ?? {};
    const url = body.url?.trim() || undefined;
    const modelName = body.modelName?.trim() || DEFAULT_MODEL_NAME;

    // Build a fast lookup keyed by the 8-char sid prefix used in filenames.
    const sessionsByPrefix = new Map<string, ReturnType<typeof allSessions>[number]>();
    for (const s of allSessions()) {
      sessionsByPrefix.set(s.id.slice(0, 8), s);
    }

    try {
      const noteIds = await findNotes(`note:"${modelName}"`, url);
      const infos = await notesInfo(noteIds, url);

      let updated = 0;
      let skipped = 0;
      let missing = 0;
      let failed = 0;
      const missingFiles: string[] = [];

      for (const info of infos) {
        const audioRaw = info.fields.Audio?.value ?? '';
        const durRaw = info.fields.AudioDurationMs?.value ?? '';
        if (durRaw.trim().length > 0) {
          skipped++;
          continue;
        }
        const m = audioRaw.match(/\[sound:([^\]]+)\]/);
        if (!m) {
          skipped++;
          continue;
        }
        const filename = m[1]!;
        // as_<8 hex>_<cueIndex>.mp3
        const parts = filename.match(/^as_([a-f0-9]{8})_(\d+)\.mp3$/i);
        if (!parts) {
          skipped++;
          continue;
        }
        const sidPrefix = parts[1]!.toLowerCase();
        const cueIndex = Number(parts[2]);
        const session = sessionsByPrefix.get(sidPrefix);
        const cue = session?.cues.find((c) => c.index === cueIndex);
        if (!session || !cue) {
          missing++;
          if (missingFiles.length < 20) missingFiles.push(filename);
          continue;
        }

        // Mirror the formula in routes/export.ts (and lib/ffmpeg.ts:extractAudio):
        // ±500 ms of padding, start clamped at 0.
        const audioStartMs = Math.max(0, cue.startMs - 500);
        const audioEndMs = cue.endMs + 500;
        const durationMs = audioEndMs - audioStartMs;

        try {
          await updateNoteFields(
            { id: info.noteId, fields: { AudioDurationMs: String(durationMs) } },
            url,
          );
          updated++;
        } catch {
          failed++;
        }
      }

      return {
        ok: true,
        scanned: infos.length,
        updated,
        skipped,
        missing,
        failed,
        missingFiles,
      };
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
