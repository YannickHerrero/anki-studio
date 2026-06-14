# Anki Studio

A small, personal web utility that turns an anime episode + subtitle file into a deck of Anki sentence cards, subs2srs-style.

The flow is three steps:

1. **Upload** a video file (mkv / mp4 / …) and a matching subtitle file (`.srt`, `.ass`, `.ssa` or `.vtt`).
2. **Review** each subtitle line one by one — audio autoplays, a mid-line screenshot is shown — and mark it `keep` or `skip`.
3. **Export** the kept lines as a single `.apkg`. During export, each kept card is enriched with translation, vocabulary and grammar notes via [OpenRouter](https://openrouter.ai), using a model of your choice.

The card template comes from [`design/japanese-sentence-card.html`](./design/japanese-sentence-card.html) — open that file in any browser to see how the cards look on AnkiMobile and desktop, in light and dark mode.

## Requirements

- Node.js 20+
- pnpm 11+
- `ffmpeg` available on `PATH`
- An [OpenRouter](https://openrouter.ai) API key — pasted into the Settings page on first run, stored only in your browser's `localStorage`

## Development

```sh
pnpm install
pnpm dev
```

This starts:

- the Fastify server on `http://127.0.0.1:5174`
- the Vite dev server on `http://localhost:5173` (proxies `/api/*` to the Fastify server)

Open the Vite URL, drop into **Settings** to paste your OpenRouter key and pick a model (Gemini 2.5 Flash or Claude Sonnet 4.6 by default — you can also type any other OpenRouter model id), then go to **Upload** and drag in your video + subtitle file.

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

## License

MIT — see [LICENSE](./LICENSE).
