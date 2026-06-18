<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';

type SessionSummary = {
  id: string;
  source: 'upload' | 'youtube';
  title: string;
  youtubeUrl?: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  cueCount: number;
  pileCount: number;
  exportedCount: number;
  pendingExportCount: number;
  hasExport: boolean;
  videoRemoved: boolean;
};

const recent = ref<SessionSummary[]>([]);
const loading = ref(true);

async function load() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    const json = (await res.json()) as { sessions: SessionSummary[] };
    recent.value = json.sessions.slice(0, 3);
  } catch {
    // non-fatal — the rest of the page works without recents.
  } finally {
    loading.value = false;
  }
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const hasRecent = computed(() => recent.value.length > 0);

onMounted(load);
</script>

<template>
  <section class="home">
    <h1>New deck</h1>
    <p class="muted">Pick a source. Both flows end in the same review and export.</p>

    <div class="home__cards">
      <RouterLink :to="{ name: 'upload' }" class="home__card">
        <div class="home__card__head">
          <span class="rule__bar"></span>
          <span class="rule__label">File</span>
        </div>
        <h2>Upload a video file</h2>
        <p>Drop a video + a matching .srt or .ass subtitle file you already have.</p>
      </RouterLink>

      <RouterLink :to="{ name: 'youtube' }" class="home__card">
        <div class="home__card__head">
          <span class="rule__bar"></span>
          <span class="rule__label">YouTube</span>
        </div>
        <h2>Paste a YouTube URL</h2>
        <p>
          We'll download the video, transcribe the Japanese audio with Whisper, and translate every
          sentence with whole-transcript context.
        </p>
      </RouterLink>
    </div>

    <div v-if="hasRecent || loading" class="recent">
      <div class="recent__head">
        <h2 class="recent__title">Recent sessions</h2>
        <RouterLink :to="{ name: 'sessions' }" class="recent__all">See all →</RouterLink>
      </div>
      <p v-if="loading && recent.length === 0" class="muted small">Loading…</p>
      <div class="recent__list">
        <RouterLink
          v-for="s in recent"
          :key="s.id"
          :to="{ name: 'review', params: { sid: s.id } }"
          class="recent__card"
        >
          <div class="recent__card__row">
            <span class="tag" :class="`tag--${s.source}`">{{ s.source }}</span>
            <span class="recent__card__title">{{ s.title }}</span>
          </div>
          <div class="recent__card__meta">
            <span>{{ s.cueCount }} cues</span>
            <span class="accent" v-if="s.pileCount > 0">·  {{ s.pileCount }} in pile</span>
            <span v-if="s.pendingExportCount > 0" class="accent">
              · {{ s.pendingExportCount }} to export
            </span>
            <span class="muted">· {{ relativeTime(s.updatedAt) }}</span>
            <span v-if="s.videoRemoved" class="warn-tag" title="Source video freed">
              video freed
            </span>
            <span v-if="s.status === 'error'" class="err-tag">error</span>
          </div>
        </RouterLink>
      </div>
    </div>

    <RouterLink :to="{ name: 'sessions' }" class="home__card home__card--wide home__card--resume">
      <div class="home__card__head">
        <span class="rule__bar"></span>
        <span class="rule__label">Resume</span>
      </div>
      <h2>Open an existing session</h2>
      <p>Pick up where you left off. All your uploads and YouTube imports are kept on disk.</p>
    </RouterLink>
  </section>
</template>

<style scoped>
.home {
  max-width: 880px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 26px;
  margin: 0 0 8px;
}
.muted {
  color: var(--pageMuted);
  font-size: 14px;
  margin: 0 0 28px;
}
.muted.small {
  font-size: 12px;
  margin: 0 0 12px;
}
.home__cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.home__card--wide {
  grid-column: span 2;
}
.home__card--resume {
  margin-top: 18px;
}
.home__card {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 8px;
  padding: 22px 24px;
  text-decoration: none;
  color: var(--pageInk);
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition:
    transform 120ms ease,
    border-color 120ms ease;
}
.home__card:hover {
  transform: translateY(-1px);
  border-color: var(--accent);
}
.home__card__head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.rule__bar {
  width: 14px;
  height: 2px;
  background: var(--accent);
}
.rule__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
h2 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 18px;
  margin: 0;
}
p {
  color: var(--pageMuted);
  font-size: 13px;
  line-height: 1.55;
  margin: 0;
}

.recent {
  margin-top: 32px;
}
.recent__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.recent__title {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 18px;
  color: var(--pageInk);
}
.recent__all {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  letter-spacing: 0.04em;
}
.recent__all:hover {
  text-decoration: underline;
}
.recent__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.recent__card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  background: var(--bBg);
  text-decoration: none;
  color: var(--pageInk);
  transition:
    border-color 120ms ease,
    transform 120ms ease;
}
.recent__card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.recent__card__row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.recent__card__title {
  font-weight: 500;
  color: var(--pageInk);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.recent__card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--pageInk);
  letter-spacing: 0.02em;
}
.recent__card__meta .accent {
  color: var(--accent);
}
.recent__card__meta .muted {
  color: var(--pageMuted);
}
.tag {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bPanel);
  color: var(--pageMuted);
  font-weight: 600;
}
.tag--youtube {
  background: var(--accentSoft);
  color: var(--accent);
}
.warn-tag,
.err-tag {
  font-size: 10px;
  letter-spacing: 0.06em;
  padding: 1px 7px;
  border-radius: 999px;
}
.warn-tag {
  background: var(--bPanel);
  color: var(--pageMuted);
}
.err-tag {
  background: rgba(200, 58, 58, 0.12);
  color: #c83a3a;
}
</style>
