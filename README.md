# Anki Studio

A small, personal web utility that turns Japanese video content into a deck of Anki sentence cards, subs2srs-style.

Two sources are supported:

- **Upload** — drop a video file (mkv / mp4 / …) and a matching subtitle file (`.srt`, `.ass`, `.ssa` or `.vtt`) you already have.
- **YouTube** — paste a YouTube URL. The tool downloads a 480p copy, transcribes the audio with OpenAI Whisper, and translates every sentence into English using the whole transcript as context for accuracy.

Both paths land you in the **Review** step (keep / skip each card; audio autoplays, screenshot shown). For YouTube cards the English translation is shown next to the Japanese line during review.

Hit **Export** to bundle the kept cards as a single `.apkg`. Each card gets vocabulary and grammar notes generated via [OpenRouter](https://openrouter.ai). For YouTube cards the preprocessing translation is reused — what you reviewed is what lands in Anki.

The card template comes from [`design/japanese-sentence-card.html`](./design/japanese-sentence-card.html) — open that file in any browser to see how the cards look on AnkiMobile and desktop, in light and dark mode.

## Requirements

- Node.js 20+
- pnpm 11+
- `ffmpeg` on `PATH`
- `yt-dlp` on `PATH` — only needed for the YouTube flow (`brew install yt-dlp`)
- An [OpenRouter](https://openrouter.ai) API key — for translation / vocabulary / grammar enrichment
- An [OpenAI](https://platform.openai.com) API key — for the YouTube flow (Whisper transcription). Skip if you only use Upload.

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

| Key       | Action              |
|-----------|---------------------|
| `K`       | Keep current card   |
| `S`       | Skip current card   |
| `←` / `→` | Previous / next card |
| `Space`   | Replay audio        |
| `M`       | Merge with previous card |

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
