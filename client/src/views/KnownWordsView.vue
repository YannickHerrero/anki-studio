<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  fetchKnownSummary,
  fetchAnkiDecks,
  syncKnown,
  importKnown,
  clearKnown,
  type KnownSummary,
} from '../api';
import { useSettingsStore } from '../stores/settings';

const settings = useSettingsStore();

const summary = ref<KnownSummary | null>(null);
const decks = ref<string[]>([]);
const loadingDecks = ref(false);
const syncing = ref(false);
const error = ref<string | null>(null);
const importText = ref('');
const importing = ref(false);

function relativeTime(ts: number): string {
  if (!ts) return 'never';
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function refresh() {
  try {
    summary.value = await fetchKnownSummary();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
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
    error.value = 'Pick at least one deck and a word field first.';
    return;
  }
  syncing.value = true;
  error.value = null;
  try {
    summary.value = await syncKnown({
      decks: settings.knownDecks,
      field: settings.wordField.trim(),
      readingField: settings.readingField.trim() || undefined,
      knownThresholdDays: settings.knownThresholdDays,
      url: settings.ankiConnectUrl,
    });
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
    summary.value = await importKnown(importText.value);
    importText.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    importing.value = false;
  }
}

async function doClear() {
  if (!confirm('Clear the known-words list?')) return;
  try {
    summary.value = await clearKnown();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(refresh);
</script>

<template>
  <section class="known">
    <h1>Known words</h1>
    <p class="muted">
      Pull your vocabulary status from Anki via AnkiConnect. A card reviewed with an interval over
      your threshold counts as <strong>known</strong>; shorter intervals are <strong>learning</strong>;
      cards with no reviews yet are <strong>created</strong>. Used to spot new words while mining.
    </p>

    <div class="stats" v-if="summary">
      <div class="stat stat--known"><b>{{ summary.known }}</b><span>known</span></div>
      <div class="stat stat--learning"><b>{{ summary.learning }}</b><span>learning</span></div>
      <div class="stat stat--created"><b>{{ summary.created }}</b><span>created</span></div>
      <div class="stat"><b>{{ summary.total }}</b><span>total</span></div>
      <div class="updated">updated {{ relativeTime(summary.updatedAt) }}<span v-if="summary.source"> · {{ summary.source }}</span></div>
    </div>

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
        <input
          type="checkbox"
          :checked="settings.knownDecks.includes(d)"
          @change="toggleDeck(d)"
        />
        {{ d }}
      </label>
    </div>

    <div class="row">
      <label class="field">
        <span class="field__label">Word field</span>
        <input v-model="settings.wordField" type="text" placeholder="e.g. Expression" />
      </label>
      <label class="field">
        <span class="field__label">Reading field (optional)</span>
        <input v-model="settings.readingField" type="text" placeholder="e.g. Reading" />
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
    <p class="hint">One word per line. Optional tab-separated columns: <code>word⇥status⇥reading</code>.</p>
    <textarea v-model="importText" rows="5" placeholder="食べる&#9;known&#10;図書館"></textarea>
    <div class="actions">
      <button class="ghost" :disabled="importing || !importText.trim()" @click="doImport">
        {{ importing ? 'Importing…' : 'Import list' }}
      </button>
      <button class="ghost danger" @click="doClear">Clear all</button>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </section>
</template>

<style scoped>
.known {
  max-width: 720px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 24px;
  margin: 0 0 8px;
}
h2 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 16px;
  margin: 26px 0 6px;
}
.muted {
  color: var(--pageMuted);
  font-size: 14px;
  line-height: 1.6;
  margin: 0 0 20px;
}
.hint {
  color: var(--pageMuted);
  font-size: 12px;
  margin: 0 0 12px;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 6px;
}
.stat {
  display: flex;
  flex-direction: column;
}
.stat b {
  font-size: 22px;
  font-family: ui-monospace, monospace;
}
.stat span {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.stat--known b {
  color: var(--accent);
}
.stat--learning b {
  color: #c8902a;
}
.updated {
  margin-left: auto;
  font-size: 12px;
  color: var(--pageMuted);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
  flex: 1;
}
.field--narrow {
  flex: 0 0 140px;
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
  border-radius: 5px;
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
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 12px;
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
  border-radius: 5px;
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
  border-radius: 5px;
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
</style>
