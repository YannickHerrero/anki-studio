import fs from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { uploadRoutes } from './routes/upload.js';
import { processRoutes } from './routes/process.js';
import { mediaRoutes } from './routes/media.js';
import { sessionRoutes } from './routes/session.js';
import { exportRoutes } from './routes/export.js';
import { retimeRoutes } from './routes/retime.js';
import { mergeRoutes } from './routes/merge.js';
import { youtubeRoutes } from './routes/youtube.js';
import { transcribeRoutes } from './routes/transcribe.js';
import { translateRoutes } from './routes/translate.js';
import { refineSplitsRoutes } from './routes/refineSplits.js';
import { alignRoutes } from './routes/align.js';
import { editCardRoutes } from './routes/editCard.js';
import { chatRoutes } from './routes/chat.js';
import { storageRoutes } from './routes/storage.js';
import { relinkRoutes } from './routes/relink.js';
import { knownRoutes } from './routes/known.js';
import { analysisRoutes } from './routes/analysis.js';
import { pickRoutes } from './routes/pick.js';
import { refineTokensRoutes } from './routes/refineTokens.js';
import { rehydrateSessions } from './lib/persistence.js';

async function main() {
  await fs.mkdir(config.tmpDir, { recursive: true });

  const { loaded, wiped } = await rehydrateSessions();

  const app = Fastify({ logger: true });
  app.log.info({ loaded, wiped }, 'rehydrated sessions from disk');

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GiB
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(uploadRoutes);
  await app.register(processRoutes);
  await app.register(mediaRoutes);
  await app.register(sessionRoutes);
  await app.register(exportRoutes);
  await app.register(retimeRoutes);
  await app.register(mergeRoutes);
  await app.register(youtubeRoutes);
  await app.register(transcribeRoutes);
  await app.register(translateRoutes);
  await app.register(refineSplitsRoutes);
  await app.register(alignRoutes);
  await app.register(editCardRoutes);
  await app.register(chatRoutes);
  await app.register(storageRoutes);
  await app.register(relinkRoutes);
  await app.register(knownRoutes);
  await app.register(analysisRoutes);
  await app.register(pickRoutes);
  await app.register(refineTokensRoutes);

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
