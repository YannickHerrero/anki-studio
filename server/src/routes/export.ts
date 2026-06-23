import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  requireSession,
  audioPath,
  screenshotPath,
  sessionDir,
  type Cue,
  type Pick,
} from '../lib/session.js';
import { buildApkg, type ApkgNote } from '../lib/apkg.js';
import { readAnkiAssets } from '../lib/ankiAssets.js';
import {
  enrichWordBatch,
  glossSentence,
  glossToHtml,
  wordDetailsToHtml,
  type SentenceGloss,
  type WordItem,
} from '../lib/openrouter.js';
import { mapWithConcurrency } from '../lib/pool.js';
import { persistSession } from '../lib/persistence.js';
import { stripFurigana } from '../lib/furigana.js';

type ExportBody = {
  deckName?: string;
  openrouterKey?: string;
  model?: string;
  appName?: string;
  /** Re-enrich and ship picks that have already been exported once. */
  includeExported?: boolean;
};

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Build the `Sentence` field: full sentence (kanji[furigana] markup) with the
 * target word's surface form wrapped in <span class="js-target">. We just do
 * a literal substring replacement on the FIRST occurrence of the surface form.
 */
function highlightTargetInSentence(sentence: string, surface: string): string {
  if (!surface) return sentence;
  const idx = sentence.indexOf(surface);
  if (idx < 0) return sentence;
  return (
    sentence.slice(0, idx) +
    `<span class="js-target">${surface}</span>` +
    sentence.slice(idx + surface.length)
  );
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

    const allPicks = session.picks;
    const toShip: Pick[] = body.includeExported
      ? [...allPicks]
      : allPicks.filter((p) => !p.exported);
    if (toShip.length === 0) {
      return reply.code(400).send({
        error: body.includeExported
          ? 'pile is empty'
          : 'no new picks to ship — add words in review or pass includeExported',
      });
    }

    // Index cues by their stable index so picks can find their source sentence.
    const cueByIndex = new Map<number, Cue>(session.cues.map((c) => [c.index, c]));
    const missing = toShip.filter((p) => !cueByIndex.has(p.cueIndex));
    if (missing.length > 0) {
      return reply.code(409).send({
        error: `${missing.length} picks reference a cue that no longer exists; delete them and retry`,
      });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (event: string, data: unknown) => reply.raw.write(sseLine(event, data));

    try {
      write('start', { total: toShip.length });

      // 1. Word-level details: one batched call per ~20 picks so a 200-pick
      //    pile still fits comfortably in one model response.
      const BATCH = 20;
      let wordDone = 0;
      const wordDetailsByPick = new Map<string, ReturnType<typeof wordDetailsToHtml>>();
      for (let i = 0; i < toShip.length; i += BATCH) {
        const slice = toShip.slice(i, i + BATCH);
        const items: WordItem[] = slice.map((p) => ({
          lemma: p.lemma,
          surface: p.surface,
          sentence: stripFurigana(cueByIndex.get(p.cueIndex)!.text),
        }));
        const details = await enrichWordBatch(items, {
          apiKey: body.openrouterKey!,
          model: body.model!,
          appName: body.appName,
        });
        details.forEach((d, k) => {
          const pick = slice[k]!;
          pick.details = d;
          // Pass lemma so the back's Word panel shows the dictionary form
          // alongside reading/pos — useful when surface is conjugated.
          const lemmaForPanel = pick.lemma !== pick.surface ? pick.lemma : undefined;
          wordDetailsByPick.set(pick.id, wordDetailsToHtml(d, lemmaForPanel));
        });
        wordDone += slice.length;
        write('progress', { kind: 'word', done: wordDone, total: toShip.length });
      }

      // 2. Interlinear gloss: one call per UNIQUE cue across the pile. The
      //    gloss also yields a natural translation we fall back on when the
      //    cue wasn't translated via /translate. A gloss failure for one cue
      //    is non-fatal — that card just ships without a gloss.
      const uniqueCueIndices = Array.from(new Set(toShip.map((p) => p.cueIndex)));
      let glossDone = 0;
      const glossByCue = new Map<number, SentenceGloss>();
      await mapWithConcurrency(uniqueCueIndices, 5, async (cueIndex) => {
        const cue = cueByIndex.get(cueIndex)!;
        try {
          const g = await glossSentence(stripFurigana(cue.text), {
            apiKey: body.openrouterKey!,
            model: body.model!,
            appName: body.appName,
          });
          glossByCue.set(cueIndex, g);
        } catch {
          // Skip this cue's gloss; the export still proceeds.
        }
        glossDone++;
        write('progress', { kind: 'gloss', done: glossDone, total: uniqueCueIndices.length });
      });

      const { front, back, css } = await readAnkiAssets();

      const safeDeck = deckName.replace(/[^\w\-]+/g, '_').slice(0, 60);
      const outName = `${safeDeck || 'deck'}.apkg`;
      const outPath = path.join(sessionDir(sid), outName);

      write('build', { stage: 'package' });

      const notes: ApkgNote[] = toShip.map((pick) => {
        const cue = cueByIndex.get(pick.cueIndex)!;
        const gloss = glossByCue.get(pick.cueIndex);
        const sentenceWithTarget = highlightTargetInSentence(cue.text, pick.surface);
        const audioFile = `as_${sid.slice(0, 8)}_${cue.index}.mp3`;
        const shotFile = `as_${sid.slice(0, 8)}_${cue.index}.jpg`;
        return {
          // Show the surface form (as the user picked it) on the front;
          // the dictionary form lives inside WordDetails on the back.
          targetWord: pick.surface,
          sentence: sentenceWithTarget,
          sentenceTranslation: cue.translation ?? gloss?.naturalTranslation ?? '',
          wordDetails: wordDetailsByPick.get(pick.id) ?? '',
          // The Grammar field now carries the interlinear gloss.
          grammar: gloss ? glossToHtml(gloss) : '',
          noteText: cue.note ?? '',
          guidSeed: `${session.id}:${pick.id}`,
          audioFilename: audioFile,
          audioPath: audioPath(sid, cue.index),
          screenshotFilename: shotFile,
          screenshotPath: screenshotPath(sid, cue.index),
        };
      });

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
      for (const pick of toShip) pick.exported = true;
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
