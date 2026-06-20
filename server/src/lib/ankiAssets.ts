import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ankiDir = path.resolve(here, '..', 'anki');

export type AnkiAssets = {
  front: string;
  back: string;
  css: string;
};

/**
 * Read the Anki note-type assets shipped with the server.
 * Shared between the .apkg exporter and the AnkiConnect sync endpoint.
 */
export async function readAnkiAssets(): Promise<AnkiAssets> {
  const [front, back, css] = await Promise.all([
    fs.readFile(path.join(ankiDir, 'front.html'), 'utf8'),
    fs.readFile(path.join(ankiDir, 'back.html'), 'utf8'),
    fs.readFile(path.join(ankiDir, 'styling.css'), 'utf8'),
  ]);
  return { front, back, css };
}
