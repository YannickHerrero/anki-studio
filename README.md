# Anki Studio

A small, personal web utility that mines Japanese video content into **vocab flashcards** — one card per target word, with the source sentence's audio and screenshot as context.

Two sources are supported:

- **Upload** — drop a video file (mkv / mp4 / …) and an optional subtitle file (`.srt`, `.ass`, `.ssa` or `.vtt`). Without a subtitle the tool transcribes with Whisper.
- **YouTube** — paste a YouTube URL. The tool downloads a 480p copy, transcribes the audio with OpenAI Whisper, and translates every sentence into English using the whole transcript as context for accuracy.

Both paths land you in the **Review** step. For each subtitle line the sentence is tokenized and shown with every word as a clickable token; audio autoplays and a mid-line screenshot is shown. Click any words you want to learn, hit **Add N card(s) to pile** (or `A`), and they're queued for export. A pile sidebar (toggle with `P`) lists everything you've picked so far. Selecting nothing skips the cue. There's no keep/skip — anything you don't pick from a cue is dropped.

During review you can open a **Chat** panel to discuss the current line with an LLM — ask about grammar, fix the translation, edit the Japanese text, or add furigana to a proper noun. Every change comes back as a diff you explicitly **Apply** or **Reject**, and only ever touches the current line.

Hit **Done — Export** to bundle the picks into a single `.apkg`. Each pick becomes one Anki note: front shows the target kanji + screenshot + autoplay audio; back adds the full sentence with furigana and the target word highlighted, the sentence translation, a per-word details panel (context-aware definition + reading + pitch + frequency + part-of-speech + usage notes), grammar, and your freeform note. Definitions are generated at build time via [OpenRouter](https://openrouter.ai) so they match how the word is used in that sentence.

The same word picked from two different sentences becomes two separate Anki notes (different example sentences) — great for seeing usage in multiple contexts. The same word picked from the same sentence is deduped silently.

Sessions are kept on disk so you can resume any of them later without regenerating. Once you're done with a session you can **Free space** to delete just the (large) source video — the cues, audio clips, screenshots, translations and pile all stay. Retiming and merging re-cut from the video, so if you want them again the tool prompts you to **re-link** the video: pick the file again (uploads) or re-download it (YouTube). A duration check warns you if the re-linked file doesn't match the original.

The **Known words** page pulls your vocabulary status from Anki via [AnkiConnect](https://foosoft.net/projects/anki-connect/): pick the deck(s) and the field holding the sentence. Each card's sentence is tokenized with [kuromoji](https://github.com/takuyaa/kuromoji.js) and every word inherits that card's review interval — over your threshold (default 10 days) is **known**, shorter is **learning**, never-reviewed is **created** — so maturing a sentence marks all its words known. During review, content words are underlined by status, each cue shows how many **new** words it has, and **Skip to next cue with new words** jumps past cues whose every word is already known.

The card template lives in [`server/src/anki/`](./server/src/anki/). Imports use a stable note-type id, so a second import updates the existing **Japanese Vocab Card** note type in place instead of creating `+`/`++` duplicates.

## Requirements

- Node.js 20+
- pnpm 11+
- `ffmpeg` on `PATH`
- `yt-dlp` on `PATH` — only needed for the YouTube flow (`brew install yt-dlp`)
- An [OpenRouter](https://openrouter.ai) API key — for translation / vocabulary / grammar enrichment
- An [OpenAI](https://platform.openai.com) API key — for the YouTube flow (Whisper transcription). Skip if you only use Upload.
- Anki running with the [AnkiConnect](https://foosoft.net/projects/anki-connect/) add-on — only needed to sync known words. Skip if you don't use the Known words feature (or import a list instead).

Both keys are pasted into the Settings page on first run and stored only in your browser's `localStorage`.

## Development

```sh
pnpm install
pnpm dev
```

This starts:

- the Fastify server on `http://127.0.0.1:5174`
- the Vite dev server on `http://localhost:5173` (proxies `/api/*` to the Fastify server)

Open the Vite URL, drop into **Settings** to paste your OpenRouter key (and an OpenAI key if you want the YouTube flow), pick a model (Gemini 2.5 Flash or Claude Sonnet 4.6 by default — you can also type any other OpenRouter model id), then from the home page pick **Upload a video file** or **Paste a YouTube URL**.

Keyboard shortcuts in the review view:

| Key       | Action                       |
|-----------|------------------------------|
| `A`       | Add selected words to the pile and advance to next cue |
| `P`       | Toggle the pile sidebar      |
| `←` / `→` | Previous / next cue          |
| `Space`   | Replay audio                 |
| `M`       | Merge with previous cue      |

Click any word in the sentence to select it; click again to deselect. Non-content
tokens (particles, punctuation) render in muted text and aren't clickable.

## A note on schema upgrades

When the on-disk session format changes incompatibly, the server bumps a
`schemaVersion` sentinel and **wipes pre-bumped sessions on the next boot** —
this is intentional for a personal tool. The Anki note type, `Japanese Vocab
Card`, is unrelated and pinned to a stable id, so re-importing always reuses
the same note type in Anki.

## Layout

```
client/   Vue 3 + Vite + Pinia frontend
server/   Fastify + TypeScript backend (ffmpeg child process, sqlite, archiver)
design/   Card design preview HTML
```

## Production build

```sh
pnpm build
```

This emits `client/dist/` (static assets) and `server/dist/` (compiled JavaScript). The server itself does not currently serve the built client; for personal use, running the dev script is enough.

## A note on YouTube

Downloading YouTube content for offline use violates YouTube's Terms of Service. This tool is intended for personal language-learning use only — make your own call about whether that's acceptable for you. Don't redistribute the resulting media.

## License

MIT — see [LICENSE](./LICENSE).
