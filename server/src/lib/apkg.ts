import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';

export type ApkgNote = {
  expression: string;
  translation: string;
  vocabulary: string;
  grammar: string;
  note?: string;
  audioFilename?: string;
  audioPath?: string;
  screenshotFilename?: string;
  screenshotPath?: string;
};

export type BuildApkgOptions = {
  deckName: string;
  modelName?: string;
  outPath: string;
  notes: ApkgNote[];
  frontTemplate: string;
  backTemplate: string;
  css: string;
};

const SCHEMA = `
CREATE TABLE col (
  id INTEGER PRIMARY KEY,
  crt INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  scm INTEGER NOT NULL,
  ver INTEGER NOT NULL,
  dty INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  ls INTEGER NOT NULL,
  conf TEXT NOT NULL,
  models TEXT NOT NULL,
  decks TEXT NOT NULL,
  dconf TEXT NOT NULL,
  tags TEXT NOT NULL
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  guid TEXT NOT NULL,
  mid INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  tags TEXT NOT NULL,
  flds TEXT NOT NULL,
  sfld TEXT NOT NULL,
  csum INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  nid INTEGER NOT NULL,
  did INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  type INTEGER NOT NULL,
  queue INTEGER NOT NULL,
  due INTEGER NOT NULL,
  ivl INTEGER NOT NULL,
  factor INTEGER NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  left INTEGER NOT NULL,
  odue INTEGER NOT NULL,
  odid INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE revlog (
  id INTEGER PRIMARY KEY,
  cid INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  ease INTEGER NOT NULL,
  ivl INTEGER NOT NULL,
  lastIvl INTEGER NOT NULL,
  factor INTEGER NOT NULL,
  time INTEGER NOT NULL,
  type INTEGER NOT NULL
);
CREATE TABLE graves (
  usn INTEGER NOT NULL,
  oid INTEGER NOT NULL,
  type INTEGER NOT NULL
);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

const FIELDS = [
  'Expression',
  'Audio',
  'Screenshot',
  'Translation',
  'Vocabulary',
  'Grammar',
  'Notes',
] as const;

const GUID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,-./:;<=>?@[]^_`{|}~';

function makeGuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest();
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]!);
  let out = '';
  const base = BigInt(GUID_ALPHABET.length);
  for (let i = 0; i < 10; i++) {
    out = GUID_ALPHABET[Number(n % base)] + out;
    n = n / base;
  }
  return out;
}

function fieldChecksum(value: string): number {
  const stripped = value.replace(/<[^>]+>/g, '').replace(/\[sound:[^\]]+\]/g, '');
  const hex = createHash('sha1').update(stripped, 'utf8').digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

function buildModel(modelId: number, deckId: number, opts: BuildApkgOptions) {
  return {
    id: modelId,
    name: opts.modelName ?? 'Japanese Sentence Card',
    type: 0,
    mod: Math.floor(Date.now() / 1000),
    usn: -1,
    sortf: 0,
    did: deckId,
    tmpls: [
      {
        name: 'Sentence',
        ord: 0,
        qfmt: opts.frontTemplate,
        afmt: opts.backTemplate,
        bqfmt: '',
        bafmt: '',
        did: null,
      },
    ],
    flds: FIELDS.map((name, ord) => ({
      name,
      ord,
      sticky: false,
      rtl: false,
      font: 'Arial',
      size: 20,
      media: [],
    })),
    css: opts.css,
    latexPre: '\\documentclass[12pt]{article}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: [[0, 'any', [0]]],
    vers: [],
    tags: [],
  };
}

function buildDeck(deckId: number, deckName: string) {
  return {
    id: deckId,
    name: deckName,
    mod: Math.floor(Date.now() / 1000),
    usn: -1,
    desc: '',
    collapsed: false,
    browserCollapsed: false,
    extendNew: 0,
    extendRev: 50,
    dyn: 0,
    conf: 1,
    newToday: [0, 0],
    revToday: [0, 0],
    lrnToday: [0, 0],
    timeToday: [0, 0],
  };
}

const DEFAULT_CONF = {
  curDeck: 1,
  activeDecks: [1],
  newSpread: 0,
  collapseTime: 1200,
  timeLim: 0,
  estTimes: true,
  dueCounts: true,
  curModel: null,
  nextPos: 1,
  sortType: 'noteFld',
  sortBackwards: false,
  addToCur: true,
  dayLearnFirst: false,
};

const DEFAULT_DCONF = {
  1: {
    id: 1,
    name: 'Default',
    replayq: true,
    lapse: { leechFails: 8, minInt: 1, delays: [10], leechAction: 0, mult: 0 },
    rev: { perDay: 200, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, ease4: 1.3, bury: false, minSpace: 1 },
    timer: 0,
    maxTaken: 60,
    usn: -1,
    new: {
      perDay: 20,
      delays: [1, 10],
      separate: true,
      ints: [1, 4, 7],
      initialFactor: 2500,
      bury: false,
      order: 1,
    },
    mod: 0,
    autoplay: true,
  },
};

export async function buildApkg(opts: BuildApkgOptions): Promise<void> {
  const tmpDb = `${opts.outPath}.sqlite`;
  if (fs.existsSync(tmpDb)) await fsp.rm(tmpDb);
  const db = new Database(tmpDb);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const nowS = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const modelId = nowMs;
  const deckId = nowMs + 1;

  const model = buildModel(modelId, deckId, opts);
  const deck = buildDeck(deckId, opts.deckName);

  db.prepare(
    `INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')`,
  ).run(
    nowS,
    nowMs,
    nowMs,
    JSON.stringify(DEFAULT_CONF),
    JSON.stringify({ [String(modelId)]: model }),
    JSON.stringify({ '1': buildDeck(1, 'Default'), [String(deckId)]: deck }),
    JSON.stringify(DEFAULT_DCONF),
  );

  const insertNote = db.prepare(
    `INSERT INTO notes VALUES (?, ?, ?, ?, -1, '', ?, ?, ?, 0, '')`,
  );
  const insertCard = db.prepare(
    `INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')`,
  );

  const mediaMap: Record<string, string> = {};
  let mediaIndex = 0;
  const mediaToCopy: Array<{ key: string; src: string }> = [];

  function registerMedia(srcPath: string | undefined, filename: string | undefined): void {
    if (!srcPath || !filename) return;
    const key = String(mediaIndex++);
    mediaMap[key] = filename;
    mediaToCopy.push({ key, src: srcPath });
  }

  for (let i = 0; i < opts.notes.length; i++) {
    const note = opts.notes[i]!;
    const noteId = nowMs + 100 + i * 2;
    const cardId = noteId + 1;
    const guid = makeGuid(`${opts.deckName}:${i}:${note.expression}`);

    registerMedia(note.audioPath, note.audioFilename);
    registerMedia(note.screenshotPath, note.screenshotFilename);

    const audioField = note.audioFilename ? `[sound:${note.audioFilename}]` : '';
    const screenshotField = note.screenshotFilename
      ? `<img src="${note.screenshotFilename}" />`
      : '';

    const fields = [
      note.expression,
      audioField,
      screenshotField,
      note.translation,
      note.vocabulary,
      note.grammar,
      note.note ?? '',
    ];
    const flds = fields.join('\x1f');

    insertNote.run(noteId, guid, modelId, nowS, flds, note.expression, fieldChecksum(note.expression));
    insertCard.run(cardId, noteId, deckId, nowS, i);
  }

  db.close();

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(opts.outPath);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.on('error', reject);
    zip.pipe(out);

    // Use the legacy filename + no meta file. Anki's importer reads `meta` as
    // a protobuf message (not JSON), so any JSON we wrote there would fail
    // protobuf decoding and abort the import. With no meta, Anki defaults to
    // the Legacy1 format which looks for `collection.anki2`. This is what
    // genanki produces and is broadly compatible.
    zip.file(tmpDb, { name: 'collection.anki2' });
    zip.append(JSON.stringify(mediaMap), { name: 'media' });
    for (const { key, src } of mediaToCopy) {
      zip.file(src, { name: key });
    }

    zip.finalize();
  });

  await fsp.rm(tmpDb, { force: true });
  const walPath = path.resolve(tmpDb + '-wal');
  const shmPath = path.resolve(tmpDb + '-shm');
  await fsp.rm(walPath, { force: true });
  await fsp.rm(shmPath, { force: true });
}
