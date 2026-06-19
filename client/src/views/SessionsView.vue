<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { RouterLink } from 'vue-router';
import { freeSpace } from '../api';

type SessionSummary = {
  id: string;
  source: 'upload' | 'youtube';
  title: string;
  youtubeUrl?: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  cueCount?: number;
  pileCount?: number;
  exportedCount?: number;
  pendingExportCount?: number;
  chunkIndex?: number;
  totalChunks?: number;
  /** Deprecated — server stopped emitting these once decisions went away. */
  totalCards?: number;
  keptCount?: number;
  skippedCount?: number;
  hasExport: boolean;
  videoRemoved: boolean;
};

const sessions = ref<SessionSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const deleting = ref<string | null>(null);
const freeing = ref<string | null>(null);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { sessions: SessionSummary[] };
    sessions.value = json.sessions;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function remove(s: SessionSummary) {
  if (!confirm(`Delete session "${s.title}"? This removes all clips and the video on disk.`)) return;
  deleting.value = s.id;
  try {
    const res = await fetch(`/api/session/${s.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sessions.value = sessions.value.filter((x) => x.id !== s.id);
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    deleting.value = null;
  }
}

async function free(s: SessionSummary) {
  if (
    !confirm(
      `Free space for "${s.title}"? This deletes the source video. ` +
        'Your cards stay, but retiming/merging needs you to re-link the video later.',
    )
  )
    return;
  freeing.value = s.id;
  try {
    const { freedBytes } = await freeSpace(s.id);
    s.videoRemoved = true;
    const mb = Math.round(freedBytes / 1_000_000);
    if (mb > 0) alert(`Freed ${mb} MB.`);
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    freeing.value = null;
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

const empty = computed(() => !loading.value && sessions.value.length === 0);

onMounted(load);
</script>

<template>
  <section class="sessions">
    <h1>Sessions</h1>
    <p class="muted">
      Every upload and YouTube import lives here until you delete it. Pick one to keep reviewing.
    </p>

    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="error" class="err">{{ error }}</p>
    <p v-else-if="empty" class="muted">
      No sessions yet. Go to <RouterLink to="/">Home</RouterLink> to start one.
    </p>

    <ul v-else class="list">
      <li v-for="s in sessions" :key="s.id" class="item">
        <div class="item__main">
          <div class="item__head">
            <span class="tag" :class="`tag--${s.source}`">{{ s.source }}</span>
            <span
              v-if="s.totalChunks && s.totalChunks > 1"
              class="tag tag--part"
              :title="`Part ${(s.chunkIndex ?? 0) + 1} of ${s.totalChunks}`"
            >
              [{{ (s.chunkIndex ?? 0) + 1 }}/{{ s.totalChunks }}]
            </span>
            <span class="item__title">{{ s.title }}</span>
          </div>
          <div class="item__stats">
            <span>{{ s.cueCount ?? 0 }} cues</span>
            <span class="accent" v-if="(s.pileCount ?? 0) > 0">{{ s.pileCount }} in pile</span>
            <span class="accent" v-if="(s.pendingExportCount ?? 0) > 0">
              {{ s.pendingExportCount }} to export
            </span>
            <span class="muted">· {{ relativeTime(s.updatedAt) }}</span>
            <span v-if="s.videoRemoved" class="muted">· video freed</span>
            <span v-if="s.status === 'error'" class="danger">· {{ s.errorMessage ?? 'error' }}</span>
            <span v-else-if="s.status !== 'ready'" class="muted">
              · needs processing
            </span>
          </div>
        </div>
        <div class="item__actions">
          <!-- Sessions that haven't finished /process land in Processing so the
               pipeline (transcribe / cut clips / translate / refineTokens)
               runs. After that they're 'ready' and we go to Review. -->
          <RouterLink
            v-if="s.status !== 'ready'"
            class="ghost primary"
            :to="{ name: 'processing', params: { sid: s.id } }"
          >
            Process
          </RouterLink>
          <RouterLink
            v-else
            class="ghost"
            :to="{ name: 'review', params: { sid: s.id } }"
          >
            Review
          </RouterLink>
          <RouterLink
            v-if="(s.pileCount ?? 0) > 0"
            class="ghost"
            :to="{ name: 'export', params: { sid: s.id } }"
          >
            Export
          </RouterLink>
          <button
            v-if="!s.videoRemoved && s.status === 'ready'"
            type="button"
            class="ghost"
            :disabled="freeing === s.id"
            @click="free(s)"
          >
            {{ freeing === s.id ? '…' : 'Free space' }}
          </button>
          <button
            type="button"
            class="ghost danger"
            :disabled="deleting === s.id"
            @click="remove(s)"
          >
            {{ deleting === s.id ? '…' : 'Delete' }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sessions {
  max-width: 880px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 24px;
  margin: 0 0 8px;
}
.muted {
  color: var(--pageMuted);
  font-size: 14px;
  margin: 0 0 22px;
}
.err {
  color: #c83a3a;
  font-size: 13px;
}
.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 18px;
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 14px 16px;
}
.item__main {
  flex: 1;
  min-width: 0;
}
.item__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 5px;
}
.tag {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bPanel);
  color: var(--pageMuted);
}
.tag--youtube {
  background: var(--accentSoft);
  color: var(--accent);
}
.tag--part {
  background: var(--bPanel);
  color: var(--pageInk);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: none;
}
.item__title {
  font-weight: 500;
  color: var(--pageInk);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.item__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--pageInk);
  letter-spacing: 0.04em;
}
.accent {
  color: var(--accent);
}
.danger {
  color: #c83a3a;
}
.item__actions {
  display: flex;
  gap: 6px;
}
.ghost {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 1px solid var(--pageLine);
  padding: 6px 12px;
  border-radius: 5px;
  color: var(--pageInk);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  letter-spacing: 0.04em;
}
.ghost.danger {
  color: #c83a3a;
  border-color: rgba(200, 58, 58, 0.4);
}
.ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
