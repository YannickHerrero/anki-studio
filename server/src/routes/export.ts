import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { requireSession, audioPath, screenshotPath, sessionDir } from '../lib/session.js';
import { buildApkg, type ApkgNote } from '../lib/apkg.js';
import {
  enrichSentence,
  vocabularyToHtml,
  grammarToHtml,
  type Enrichment,
} from '../lib/openrouter.js';
import { mapWithConcurrency } from '../lib/pool.js';
import { persistSession } from '../lib/persistence.js';
import { stripFurigana } from '../lib/furigana.js';

type ExportBody = {
  deckName?: string;
  openrouterKey?: string;
  model?: string;
  appName?: string;
  /** Include cards that were already shipped in a previous .apkg. Default false. */
  includeExported?: boolean;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const ankiDir = path.resolve(here, '..', 'anki');

async function readAnkiAssets() {
  const [front, back, css] = await Promise.all([
    fs.promises.readFile(path.join(ankiDir, 'front.html'), 'utf8'),
    fs.promises.readFile(path.join(ankiDir, 'back.html'), 'utf8'),
    fs.promises.readFile(path.join(ankiDir, 'styling.css'), 'utf8'),
  ]);
  return { front, back, css };
}

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function exportRoutes(app: FastifyInstance) {
  app.post('/session/:sid/export', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = (req.body as ExportBody | undefined) ?? {};
    const session = requireSession(sid);

    const deckName = body.deckName?.trim() || 'Anki Studio Export';
    if (!body.openrouterKey || !body.model) {
      return reply.code(400).send({ error: 'openrouterKey and model are required' });
    }

    const allKept = session.cues.filter((c) => session.decisions?.[c.index] === 'keep');
    const kept = body.includeExported
      ? allKept
      : allKept.filter((c) => !c.exported);
    if (kept.length === 0) {
      return reply.code(400).send({
        error: body.includeExported
          ? 'no cards marked as keep'
          : 'no new kept cards — review more or pass includeExported to re-export',
      });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    write('start', { total: kept.length });

    try {
      let done = 0;
      const enrichments = new Map<number, Enrichment>();
      await mapWithConcurrency(kept, 5, async (card) => {
        const sentence = stripFurigana(card.text);
        const input = card.translation
          ? { sentence, existingTranslation: card.translation }
          : { sentence };
        const e = await enrichSentence(input, {
          apiKey: body.openrouterKey!,
          model: body.model!,
          appName: body.appName,
        });
        enrichments.set(card.index, e);
        done++;
        write('progress', { kind: 'enrich', done, total: kept.length });
      });

      const { front, back, css } = await readAnkiAssets();

      const safeDeck = deckName.replace(/[^\w\-]+/g, '_').slice(0, 60);
      const outName = `${safeDeck || 'deck'}.apkg`;
      const outPath = path.join(sessionDir(sid), outName);

      const notes: ApkgNote[] = kept.map((card) => {
        const e = enrichments.get(card.index)!;
        const audioFile = `as_${sid.slice(0, 8)}_${card.index}.mp3`;
        const shotFile = `as_${sid.slice(0, 8)}_${card.index}.jpg`;
        return {
          expression: card.text,
          translation: e.translation,
          vocabulary: vocabularyToHtml(e.vocabulary),
          grammar: grammarToHtml(e.grammar),
          note: card.note ?? '',
          audioFilename: audioFile,
          audioPath: audioPath(sid, card.index),
          screenshotFilename: shotFile,
          screenshotPath: screenshotPath(sid, card.index),
        };
      });

      write('build', { stage: 'package' });
      await buildApkg({
        deckName,
        outPath,
        notes,
        frontTemplate: front,
        backTemplate: back,
        css,
      });

      const stat = await fs.promises.stat(outPath);
      write('ready', {
        downloadUrl: `/session/${sid}/export/file`,
        filename: outName,
        size: stat.size,
      });
      session.errorMessage = undefined;
      session.lastApkgPath = outPath;
      session.lastApkgName = outName;
      // Mark each card we just shipped so the next export skips it by default.
      for (const card of kept) card.exported = true;
      persistSession(session, { immediate: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      write('error', { message });
    } finally {
      reply.raw.end();
    }
  });

  app.get('/session/:sid/export/file', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const session = requireSession(sid);
    if (!session.lastApkgPath) return reply.code(404).send({ error: 'no deck built yet' });

    const stat = await fs.promises.stat(session.lastApkgPath);
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', stat.size)
      .header(
        'Content-Disposition',
        `attachment; filename="${session.lastApkgName ?? 'deck.apkg'}"`,
      );
    return reply.send(fs.createReadStream(session.lastApkgPath));
  });
}
