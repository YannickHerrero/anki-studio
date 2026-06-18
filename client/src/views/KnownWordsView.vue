<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import {
  fetchKnownSummary,
  fetchKnownWords,
  fetchKnownHistory,
  fetchAnkiDecks,
  syncKnown,
  importKnown,
  clearKnown,
  type KnownSummary,
  type KnownWord,
  type KnownSnapshot,
  type WordStatus,
} from '../api';
import { useSettingsStore } from '../stores/settings';
import Sparkline from '../components/Sparkline.vue';

const settings = useSettingsStore();

const summary = ref<KnownSummary | null>(null);
const words = ref<KnownWord[]>([]);
const history = ref<KnownSnapshot[]>([]);

const decks = ref<string[]>([]);
const loadingDecks = ref(false);
const syncing = ref(false);
const importing = ref(false);
const error = ref<string | null>(null);
const importText = ref('');
const showManage = ref(false);

const tab = ref<WordStatus>('known');
const search = ref('');
const LIMIT = 600;

async function refreshAll() {
  try {
    const [s, w, h] = await Promise.all([
      fetchKnownSummary(),
      fetchKnownWords(),
      fetchKnownHistory(),
    ]);
    summary.value = s;
    words.value = w;
    history.value = h;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const knownSeries = computed(() => history.value.map((s) => s.known));

// Growth over the last 7 days — the number we want to see climb.
const weekDelta = computed<number | null>(() => {
  if (history.value.length < 2 || !summary.value) return null;
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toLocaleDateString('en-CA');
  let base = history.value[0]!;
  for (const s of history.value) if (s.date <= cutoff) base = s;
  return summary.value.known - base.known;
});

const filtered = computed(() => {
  const q = search.value.trim();
  return words.value.filter(
    (w) => w.status === tab.value && (!q || w.word.includes(q) || w.reading.includes(q)),
  );
});
const visible = computed(() => filtered.value.slice(0, LIMIT));

function relativeTime(ts: number): string {
  if (!ts) return 'never';
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function loadDecks() {
  loadingDecks.value = true;
  error.value = null;
  try {
    decks.value = await fetchAnkiDecks(settings.ankiConnectUrl);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingDecks.value = false;
  }
}

function toggleDeck(deck: string) {
  const i = settings.knownDecks.indexOf(deck);
  if (i >= 0) settings.knownDecks.splice(i, 1);
  else settings.knownDecks.push(deck);
}

async function sync() {
  if (!settings.knownDecks.length || !settings.wordField.trim()) {
    error.value = 'Pick at least one deck and a sentence field first.';
    return;
  }
  syncing.value = true;
  error.value = null;
  try {
    await syncKnown({
      decks: settings.knownDecks,
      field: settings.wordField.trim(),
      knownThresholdDays: settings.knownThresholdDays,
      url: settings.ankiConnectUrl,
    });
    await refreshAll();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    syncing.value = false;
  }
}

async function doImport() {
  if (!importText.value.trim()) return;
  importing.value = true;
  error.value = null;
  try {
    await importKnown(importText.value);
    importText.value = '';
    await refreshAll();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    importing.value = false;
  }
}

async function doClear() {
  if (!confirm('Clear the known-words list?')) return;
  try {
    await clearKnown();
    await refreshAll();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(refreshAll);
</script>

<template>
  <section class="known">
    <header class="head">
      <h1>Known words</h1>
      <button class="manage-toggle" @click="showManage = !showManage">
        {{ showManage ? 'Hide setup' : 'Sync / setup' }}
      </button>
    </header>

    <div class="hero">
      <div class="tile tile--known">
        <div class="tile__top">
          <span class="tile__label">Words known</span>
          <span
            v-if="weekDelta !== null"
            class="delta"
            :class="{ 'delta--up': weekDelta > 0, 'delta--flat': weekDelta <= 0 }"
          >
            {{ weekDelta > 0 ? `+${weekDelta}` : weekDelta }} this week
          </span>
        </div>
        <div class="tile__value">{{ (summary?.known ?? 0).toLocaleString() }}</div>
        <Sparkline :values="knownSeries" />
        <p class="tile__motivate">
          <template v-if="weekDelta && weekDelta > 0">
            Keep mining — every matured card pushes this higher. 🌱
          </template>
          <template v-else-if="history.length < 2">
            Baseline set. Sync each week to watch it climb.
          </template>
          <template v-else>A new week to grow it. Mine a few cards.</template>
        </p>
      </div>

      <div class="tile tile--learning">
        <div class="tile__top">
          <span class="tile__label">Learning</span>
        </div>
        <div class="tile__value">{{ (summary?.learning ?? 0).toLocaleString() }}</div>
        <p class="tile__sub">
          <span class="dot dot--created"></span>{{ (summary?.created ?? 0).toLocaleString() }} in
          your decks, not started
        </p>
        <p class="tile__updated" v-if="summary">updated {{ relativeTime(summary.updatedAt) }}</p>
      </div>
    </div>

    <div v-if="showManage" class="manage">
      <h2>Sync from Anki</h2>
      <p class="hint">Anki must be running with the AnkiConnect add-on.</p>
      <label class="field">
        <span class="field__label">AnkiConnect URL</span>
        <input v-model="settings.ankiConnectUrl" type="text" />
      </label>
      <button class="ghost" :disabled="loadingDecks" @click="loadDecks">
        {{ loadingDecks ? 'Loading…' : 'Load decks' }}
      </button>
      <div v-if="decks.length" class="decks">
        <label v-for="d in decks" :key="d" class="deck">
          <input type="checkbox" :checked="settings.knownDecks.includes(d)" @change="toggleDeck(d)" />
          {{ d }}
        </label>
      </div>
      <div class="row">
        <label class="field">
          <span class="field__label">Sentence field</span>
          <input v-model="settings.wordField" type="text" placeholder="e.g. Expression" />
        </label>
        <label class="field field--narrow">
          <span class="field__label">Known after (days)</span>
          <input v-model.number="settings.knownThresholdDays" type="number" min="1" />
        </label>
      </div>
      <button class="primary" :disabled="syncing" @click="sync">
        {{ syncing ? 'Syncing…' : 'Sync from Anki' }}
      </button>

      <h2>Import a list</h2>
      <p class="hint">One word per line. Optional tab columns: <code>word⇥status⇥reading</code>.</p>
      <textarea v-model="importText" rows="4" placeholder="食べる&#9;known&#10;図書館"></textarea>
      <div class="actions">
        <button class="ghost" :disabled="importing || !importText.trim()" @click="doImport">
          {{ importing ? 'Importing…' : 'Import list' }}
        </button>
        <button class="ghost danger" @click="doClear">Clear all</button>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
    </div>

    <div class="list">
      <div class="list__bar">
        <div class="tabs">
          <button :class="{ on: tab === 'known' }" @click="tab = 'known'">
            Known <b>{{ (summary?.known ?? 0).toLocaleString() }}</b>
          </button>
          <button :class="{ on: tab === 'learning' }" @click="tab = 'learning'">
            Learning <b>{{ (summary?.learning ?? 0).toLocaleString() }}</b>
          </button>
        </div>
        <input v-model="search" class="search" type="search" placeholder="Search word or reading…" />
      </div>

      <p v-if="!words.length && !error" class="empty">
        No words yet — open <strong>Sync / setup</strong> to pull them from Anki.
      </p>
      <p v-else-if="!filtered.length" class="empty">No matches.</p>

      <div v-else class="chips">
        <div v-for="w in visible" :key="w.word" class="chip" :class="`chip--${w.status}`">
          <span class="chip__word">{{ w.word }}</span>
          <span v-if="w.reading" class="chip__reading">{{ w.reading }}</span>
        </div>
      </div>
      <p v-if="filtered.length > LIMIT" class="more">
        Showing {{ LIMIT.toLocaleString() }} of {{ filtered.length.toLocaleString() }} — search to
        narrow.
      </p>
    </div>
  </section>
</template>

<style scoped>
.known {
  max-width: 920px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 26px;
  margin: 0;
}
.manage-toggle {
  background: transparent;
  border: 1px solid var(--pageLine);
  border-radius: 999px;
  padding: 7px 16px;
  font-size: 12px;
  color: var(--pageInk);
  cursor: pointer;
  letter-spacing: 0.04em;
}

/* Hero stat tiles */
.hero {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
  gap: 16px;
  margin-bottom: 26px;
}
.tile {
  border: 1px solid var(--pageLine);
  border-radius: 14px;
  padding: 22px 24px;
  background: var(--bBg);
  box-shadow: 0 10px 30px var(--bShadow);
}
.tile--known {
  background: linear-gradient(160deg, var(--accentSoft), var(--bBg) 70%);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--pageLine));
}
.tile__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.tile__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.tile__value {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 64px;
  line-height: 1.05;
  letter-spacing: -0.01em;
  margin: 6px 0 4px;
  color: var(--pageInk);
  font-variant-numeric: tabular-nums;
}
.tile--known .tile__value {
  color: var(--accent);
}
.tile__motivate {
  font-size: 13px;
  color: var(--pageMuted);
  margin: 8px 0 0;
  line-height: 1.5;
}
.tile__sub {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--pageMuted);
  margin: 8px 0 0;
}
.tile__updated {
  font-size: 11px;
  color: var(--pageMuted);
  margin: 14px 0 0;
  letter-spacing: 0.04em;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.dot--created {
  background: var(--pageMuted);
}
.delta {
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 999px;
  letter-spacing: 0.02em;
}
.delta--up {
  color: var(--accent);
  background: var(--accentSoft);
}
.delta--flat {
  color: var(--pageMuted);
  background: var(--bPanel);
}

/* Word list */
.list__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.tabs {
  display: flex;
  gap: 8px;
}
.tabs button {
  background: transparent;
  border: 1px solid var(--pageLine);
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--pageMuted);
  cursor: pointer;
}
.tabs button.on {
  color: var(--pageInk);
  border-color: var(--accent);
  background: var(--accentSoft);
}
.tabs b {
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}
.search {
  flex: 1;
  min-width: 180px;
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--pageInk);
  font-family: inherit;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 8px 13px;
  border-radius: 9px;
  background: var(--bBg);
  border: 1px solid var(--bLine);
}
.chip--known {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--bLine));
}
.chip--learning {
  border-color: color-mix(in srgb, #c8902a 45%, var(--bLine));
}
.chip__word {
  font-family: 'Zen Kaku Gothic New', sans-serif;
  font-size: 16px;
  color: var(--pageInk);
  font-weight: 500;
}
.chip__reading {
  font-size: 10px;
  color: var(--pageMuted);
}
.more,
.empty {
  color: var(--pageMuted);
  font-size: 13px;
  margin-top: 16px;
}

/* Manage panel */
.manage {
  border: 1px solid var(--pageLine);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 26px;
  background: var(--bPanel);
}
.manage h2 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 15px;
  margin: 18px 0 6px;
}
.manage h2:first-child {
  margin-top: 0;
}
.hint {
  color: var(--pageMuted);
  font-size: 12px;
  margin: 0 0 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
  flex: 1;
}
.field--narrow {
  flex: 0 0 150px;
}
.field__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
input,
textarea {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 9px 11px;
  font-size: 14px;
  color: var(--pageInk);
  font-family: inherit;
  width: 100%;
}
.decks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--pageLine);
  border-radius: 8px;
  padding: 12px;
  background: var(--bBg);
}
.deck {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.deck input {
  width: auto;
}
.primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: white;
  padding: 9px 18px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  margin-top: 6px;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ghost {
  background: transparent;
  border: 1px solid var(--pageLine);
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--pageInk);
}
.ghost.danger {
  color: #c83a3a;
  border-color: rgba(200, 58, 58, 0.4);
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}
.err {
  color: #c83a3a;
  font-size: 13px;
  margin-top: 14px;
}
code {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

@media (max-width: 640px) {
  .hero {
    grid-template-columns: 1fr;
  }
}
</style>
