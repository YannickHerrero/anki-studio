# Anki Studio

A small web utility that turns an anime episode + subtitle file into a deck of Anki sentence cards, subs2srs-style.

The flow is three steps:

1. **Upload** a video and a subtitle file (`.srt` or `.ass`).
2. **Review** each subtitle line one by one — audio autoplays, a mid-line screenshot is shown — and mark it `keep` or `skip`.
3. **Export** the kept lines as a `.apkg`. During export, the kept cards are enriched with translation, vocabulary and grammar notes via [OpenRouter](https://openrouter.ai) using a model of your choice.

The card template is the Japanese Sentence Card design under [`design/`](./design).

## Status

Personal project, work in progress. See [`design/japanese-sentence-card.html`](./design/japanese-sentence-card.html) for the card design preview.

## Requirements

- Node.js 20+
- pnpm 8+
- `ffmpeg` on `PATH`
- An OpenRouter API key (for the enrichment step)

## Development

```sh
pnpm install
pnpm dev
```

The Vite dev server runs on `http://localhost:5173` and proxies API requests to the Fastify server on `http://localhost:5174`.

## License

MIT — see [LICENSE](./LICENSE).
