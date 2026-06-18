<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  addPicks,
  fetchAnalysis,
  fetchCards,
  fetchPicks,
  mediaUrl,
  mergeWithPrevious,
  relinkVideo,
  relinkYoutube,
  removePick,
  streamSse,
  updateCard,
  type CardAnalysis,
  type CardSummary,
  type EditProposal,
  type PickTokenInput,
} from '../api';
import { useSessionStore } from '../stores/session';
import { useSettingsStore } from '../stores/settings';
import ChatPanel from '../components/ChatPanel.vue';
import MenuDropdown from '../components/MenuDropdown.vue';

const props = defineProps<{ sid: string }>();
const router = useRouter();
const session = useSessionStore();
const settings = useSettingsStore();

const index = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const audioEl = ref<HTMLAudioElement | null>(null);

const showRetime = ref(false);
const retimeSeconds = ref(0);
const retiming = ref(false);
const retimeDone = ref(0);
const retimeTotal = ref(0);
const retimeError = ref<string | null>(null);

const showChat = ref(false);
const showPile = ref(true);
const merging = ref(false);
const mergeError = ref<string | null>(null);
const canMerge = computed(() => index.value > 0 && !!current.value && !merging.value);

const source = ref<'upload' | 'youtube'>('upload');
const videoRemoved = ref(false);
const showRelink = ref(false);
const relinking = ref(false);
const relinkProgress = ref(0);
const relinkError = ref<string | null>(null);
const relinkMismatch = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const current = computed<CardSummary | undefined>(() => session.cards[index.value]);

// Selection: per-cue map of token-index → true. Cleared on cue change.
const selectedTokensByCue = ref<Record<number, Set<number>>>({});
const currentSelection = computed<Set<number>>(() => {
  const cue = current.value;
  if (!cue) return new Set();
  return selectedTokensByCue.value[cue.index] ?? new Set();
});
const selectedCount = computed(() => currentSelection.value.size);

const analysis = ref<Record<number, CardAnalysis>>({});
const currentAnalysis = computed<CardAnalysis | undefined>(() =>
  current.value ? analysis.value[current.value.index] : undefined,
);
const hasKnownData = computed(() =>
  Object.values(analysis.value).some(
    (a) => a.knownCount + a.learningCount + a.createdCount > 0,
  ),
);

async function loadAnalysis() {
  try {
    analysis.value = await fetchAnalysis(props.sid);
  } catch {
    // optional — known list / tokenizer may not be ready
  }
}

async function refreshPicks() {
  try {
    const data = await fetchPicks(props.sid);
    session.picks = data.picks;
  } catch (err) {
    // non-fatal — pile UI may briefly be stale
  }
}

const noteDraft = ref('');
let noteTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNoteSave() {
  const cue = current.value;
  if (!cue) return;
  if (noteTimer) clearTimeout(noteTimer);
  const value = noteDraft.value;
  noteTimer = setTimeout(() => {
    cue.note = value;
    void updateCard(props.sid, cue.index, { note: value });
  }, 500);
}

function toggleToken(tokenIdx: number) {
  const cue = current.value;
  if (!cue) return;
  const set = selectedTokensByCue.value[cue.index] ?? new Set<number>();
  if (set.has(tokenIdx)) set.delete(tokenIdx);
  else set.add(tokenIdx);
  // Reassign so Vue reactivity picks up the change.
  selectedTokensByCue.value = {
    ...selectedTokensByCue.value,
    [cue.index]: new Set(set),
  };
}

function clearCueSelection(cueIndex: number) {
  if (selectedTokensByCue.value[cueIndex]) {
    const next = { ...selectedTokensByCue.value };
    delete next[cueIndex];
    selectedTokensByCue.value = next;
  }
}

async function commitPicks() {
  const cue = current.value;
  if (!cue) return;
  const analysisRow = currentAnalysis.value;
  const selected = currentSelection.value;
  if (!analysisRow || selected.size === 0) return;
  const tokens: PickTokenInput[] = [];
  selected.forEach((tokenIdx) => {
    const tok = analysisRow.tokens[tokenIdx];
    if (!tok) return;
    tokens.push({
      surface: tok.t,
      lemma: tok.lemma ?? tok.t,
      reading: tok.reading ?? '',
    });
  });
  if (tokens.length === 0) return;
  try {
    await addPicks(props.sid, cue.index, tokens);
    clearCueSelection(cue.index);
    await refreshPicks();
    next();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function removeFromPile(pickId: string) {
  const before = session.picks.length;
  session.picks = session.picks.filter((p) => p.id !== pickId);
  try {
    await removePick(props.sid, pickId);
  } catch (err) {
    // Best-effort: refetch the truth if delete failed.
    void refreshPicks();
    error.value = err instanceof Error ? err.message : String(err);
    return;
  }
  if (session.picks.length === before) void refreshPicks();
}

function next() {
  if (index.value < session.cards.length - 1) index.value++;
}
function prev() {
  if (index.value > 0) index.value--;
}

function replay() {
  if (audioEl.value) {
    audioEl.value.currentTime = 0;
    void audioEl.value.play();
  }
}

function nextCueWithNewWords() {
  for (let i = index.value + 1; i < session.cards.length; i++) {
    const cue = session.cards[i]!;
    const a = analysis.value[cue.index];
    if (!a || a.newCount > 0) {
      index.value = i;
      return;
    }
  }
  // None found — stay put.
}

function onKey(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'a' || e.key === 'A') void commitPicks();
  else if (e.key === 'ArrowRight') next();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.code === 'Space') {
    e.preventDefault();
    replay();
  } else if (e.key === 'm' || e.key === 'M') void mergePrev();
  else if (e.key === 'p' || e.key === 'P') showPile.value = !showPile.value;
}

async function mergePrev() {
  if (!canMerge.value || !current.value) return;
  if (videoRemoved.value) {
    promptRelink();
    return;
  }
  merging.value = true;
  mergeError.value = null;
  try {
    const res = await mergeWithPrevious(props.sid, current.value.index);
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    void refreshPicks(); // merge re-keyed picks server-side
    index.value = res.newPosition;
  } catch (err) {
    mergeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    merging.value = false;
  }
}

async function retime(scope: 'all' | 'from-here') {
  const deltaMs = Math.round(retimeSeconds.value * 1000);
  if (!deltaMs || !current.value) return;
  retiming.value = true;
  retimeError.value = null;
  retimeDone.value = 0;
  retimeTotal.value = 0;

  try {
    await streamSse(
      `/session/${props.sid}/retime`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deltaMs,
          fromIndex: scope === 'from-here' ? current.value.index : 0,
        }),
      },
      ({ event, data }) => {
        const d = data as { total?: number; done?: number; message?: string };
        if (event === 'start') retimeTotal.value = d.total ?? 0;
        else if (event === 'progress') retimeDone.value = d.done ?? 0;
        else if (event === 'error') retimeError.value = d.message ?? 'retime failed';
      },
    );
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    const i = index.value;
    index.value = -1;
    await new Promise((r) => setTimeout(r, 0));
    index.value = i;
  } catch (err) {
    retimeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    retiming.value = false;
  }
}

watch(index, () => {
  if (audioEl.value) {
    audioEl.value.currentTime = 0;
    audioEl.value.play().catch(() => undefined);
  }
});

watch(
  current,
  (cue) => {
    if (noteTimer) clearTimeout(noteTimer);
    noteDraft.value = cue?.note ?? '';
  },
  { immediate: true },
);

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  session.sessionId = props.sid;
  try {
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    source.value = data.source;
    videoRemoved.value = data.videoRemoved;
    void loadAnalysis();
    void refreshPicks();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  if (noteTimer) clearTimeout(noteTimer);
});

function toggleRetime() {
  if (videoRemoved.value) {
    promptRelink();
    return;
  }
  showRetime.value = !showRetime.value;
}

function promptRelink() {
  showRetime.value = false;
  relinkError.value = null;
  relinkMismatch.value = false;
  showRelink.value = true;
}

function chooseFile() {
  fileInput.value?.click();
}

async function onFilePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  relinking.value = true;
  relinkError.value = null;
  try {
    const res = await relinkVideo(props.sid, file);
    videoRemoved.value = false;
    relinkMismatch.value = res.mismatch;
    if (!res.mismatch) showRelink.value = false;
  } catch (err) {
    relinkError.value = err instanceof Error ? err.message : String(err);
  } finally {
    relinking.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

async function relinkFromYoutube() {
  relinking.value = true;
  relinkError.value = null;
  relinkProgress.value = 0;
  try {
    await relinkYoutube(props.sid, ({ event, data }) => {
      const d = data as { pct?: number; mismatch?: boolean; message?: string };
      if (event === 'download') relinkProgress.value = d.pct ?? 0;
      else if (event === 'done') {
        videoRemoved.value = false;
        relinkMismatch.value = !!d.mismatch;
      } else if (event === 'error') relinkError.value = d.message ?? 're-link failed';
    });
    if (!relinkError.value && !relinkMismatch.value) showRelink.value = false;
  } catch (err) {
    relinkError.value = err instanceof Error ? err.message : String(err);
  } finally {
    relinking.value = false;
  }
}

async function applyEdit(edit: EditProposal) {
  const cue = current.value;
  if (!cue) return;
  try {
    const updated = await updateCard(props.sid, cue.index, edit);
    cue.text = updated.text;
    cue.translation = updated.translation;
    cue.note = updated.note;
    noteDraft.value = updated.note ?? '';
    // Tokenization may shift indices on text edit — clear selection for this cue.
    clearCueSelection(cue.index);
    void loadAnalysis();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function goExport() {
  router.push({ name: 'export', params: { sid: props.sid } });
}

const picksForCurrentCue = computed(() =>
  current.value ? session.picks.filter((p) => p.cueIndex === current.value!.index) : [],
);
</script>

<template>
  <section class="review" :class="{ 'review--wide': showChat || showPile }">
    <header class="review__header">
      <div class="status-cluster">
        <div class="counts">
          <span class="counts__seg counts__seg--pile">
            <b>{{ session.pileCount }}</b> in pile
          </span>
          <span
            v-if="picksForCurrentCue.length > 0"
            class="counts__seg counts__seg--here"
          >
            <b>{{ picksForCurrentCue.length }}</b> from this cue
          </span>
        </div>
        <span
          v-if="currentAnalysis && hasKnownData"
          class="newchip"
          :class="currentAnalysis.newCount === 0 ? 'newchip--allknown' : 'newchip--new'"
        >
          {{ currentAnalysis.newCount === 0 ? 'all known' : `${currentAnalysis.newCount} new` }}
        </span>
      </div>
      <div class="position">{{ index + 1 }} / {{ session.cards.length }}</div>
      <div class="header-actions">
        <button class="ghost" :class="{ active: showPile }" @click="showPile = !showPile">
          Pile ({{ session.pileCount }})
        </button>
        <button class="ghost" :class="{ active: showChat }" @click="showChat = !showChat">
          Chat
        </button>
        <MenuDropdown label="Tools">
          <button :disabled="!canMerge" @click="mergePrev">
            {{ merging ? 'Merging…' : 'Merge with previous' }}
          </button>
          <button @click="toggleRetime">Retime</button>
          <button v-if="hasKnownData" @click="nextCueWithNewWords">
            Skip to next cue with new words
          </button>
          <button
            v-if="hasKnownData"
            @click="settings.underlineByStatus = !settings.underlineByStatus"
          >
            {{ settings.underlineByStatus ? '✓ ' : '' }}Underline by status
          </button>
        </MenuDropdown>
        <button class="ghost" @click="goExport">Done — Export</button>
      </div>
    </header>
    <p v-if="mergeError" class="err">{{ mergeError }}</p>

    <div v-if="showRelink" class="retime">
      <input
        ref="fileInput"
        type="file"
        accept="video/*,.mkv"
        style="display: none"
        @change="onFilePicked"
      />
      <div class="retime__row">
        <span class="retime__label">Re-link</span>
        <span class="retime__hint">
          Retiming and merging re-cut from the source video, which was freed. Re-link it to continue.
        </span>
      </div>
      <div class="retime__row">
        <button
          v-if="source === 'youtube'"
          class="primary"
          :disabled="relinking"
          @click="relinkFromYoutube"
        >
          {{ relinking ? `Downloading ${relinkProgress}%…` : 'Re-download from YouTube' }}
        </button>
        <button v-else class="primary" :disabled="relinking" @click="chooseFile">
          {{ relinking ? 'Linking…' : 'Choose video file…' }}
        </button>
        <button class="ghost" :disabled="relinking" @click="showRelink = false">Cancel</button>
      </div>
      <div v-if="relinkMismatch" class="retime__hint" style="color: #c83a3a">
        Warning: this file's duration differs from the original — re-cuts may be misaligned.
        It's been linked anyway; use only if you're sure it's the same video.
      </div>
      <div v-if="relinkError" class="err">{{ relinkError }}</div>
    </div>

    <div v-if="showRetime" class="retime">
      <div class="retime__row">
        <label class="retime__label">Shift</label>
        <input
          v-model.number="retimeSeconds"
          type="number"
          step="0.05"
          placeholder="seconds"
          :disabled="retiming"
        />
        <span class="retime__hint">seconds — positive delays, negative advances</span>
      </div>
      <div class="retime__row">
        <button class="primary" :disabled="!retimeSeconds || retiming" @click="retime('all')">
          Apply to all
        </button>
        <button
          class="primary"
          :disabled="!retimeSeconds || retiming"
          @click="retime('from-here')"
        >
          Apply from here onwards
        </button>
        <button class="ghost" :disabled="retiming" @click="showRetime = false">Cancel</button>
      </div>
      <div v-if="retiming || retimeTotal" class="retime__progress">
        Re-cutting {{ retimeDone }} / {{ retimeTotal }}
      </div>
      <div v-if="retimeError" class="err">{{ retimeError }}</div>
    </div>

    <div class="review__main" :class="{ 'review__main--side': showChat || showPile }">
    <div class="review__col">
    <p v-if="loading" class="muted">Loading…</p>
    <p v-else-if="error" class="err">{{ error }}</p>
    <p v-else-if="!current" class="muted">No cards.</p>
    <article v-else class="card">
      <div class="card__shot">
        <img v-if="current.screenshotReady" :src="mediaUrl(current.screenshotUrl)" alt="frame" />
        <div v-else class="card__shot--pending">screenshot not ready</div>
      </div>
      <div class="card__body">
        <div class="rule">
          <span class="rule__bar"></span><span class="rule__label">Sentence</span>
        </div>

        <!-- Interactive tokenized sentence -->
        <p class="sentence" v-if="currentAnalysis">
          <span
            v-for="(tok, i) in currentAnalysis.tokens"
            :key="i"
            class="tok"
            :class="[
              tok.s && settings.underlineByStatus ? `tok--${tok.s}` : '',
              currentSelection.has(i) ? 'tok--picked' : '',
              tok.lemma ? 'tok--clickable' : 'tok--literal',
            ]"
            @click="tok.lemma ? toggleToken(i) : null"
          >{{ tok.t }}</span>
        </p>
        <p class="sentence sentence--plain" v-else>{{ current.text }}</p>

        <p v-if="current.translation" class="translation">{{ current.translation }}</p>

        <div class="commit-row">
          <button
            class="primary commit-btn"
            :disabled="selectedCount === 0"
            @click="commitPicks"
          >
            {{ selectedCount === 0
              ? 'Click words to add'
              : `Add ${selectedCount} card${selectedCount === 1 ? '' : 's'} to pile (A)` }}
          </button>
          <span v-if="picksForCurrentCue.length > 0" class="muted small">
            Already added from this cue:
            <span class="from-here" v-for="p in picksForCurrentCue" :key="p.id">{{ p.lemma }}</span>
          </span>
        </div>

        <audio
          v-if="current.audioReady"
          ref="audioEl"
          :src="mediaUrl(current.audioUrl)"
          autoplay
          controls
        />
        <p v-else class="muted">audio not ready</p>

        <div class="rule">
          <span class="rule__bar"></span><span class="rule__label">Note</span>
        </div>
        <textarea
          v-model="noteDraft"
          class="note"
          rows="2"
          placeholder="Note shared by every card from this cue…"
          @input="scheduleNoteSave"
        ></textarea>
      </div>
    </article>
    </div>

    <aside v-if="showPile" class="review__side">
      <h3>Pile <span class="muted small">({{ session.pileCount }})</span></h3>
      <p v-if="session.picks.length === 0" class="muted small">
        Empty — click words in any sentence and press A.
      </p>
      <ul v-else class="pile-list">
        <li v-for="p in session.picks" :key="p.id" class="pile-item">
          <button class="pile-item__head" @click="index = session.cards.findIndex((c) => c.index === p.cueIndex)">
            <span class="pile-item__lemma">{{ p.lemma }}</span>
            <span v-if="p.surface !== p.lemma" class="pile-item__surface muted small">({{ p.surface }})</span>
          </button>
          <span class="pile-item__meta muted small">cue #{{ p.cueIndex }}</span>
          <span v-if="p.exported" class="pile-item__exported small">exported</span>
          <button class="pile-item__del" title="Remove from pile" @click="removeFromPile(p.id)">
            ×
          </button>
        </li>
      </ul>
    </aside>

    <div v-if="showChat && current" class="review__chat">
      <ChatPanel :sid="sid" :card="current" @apply="applyEdit" />
    </div>
    </div>
  </section>
</template>

<style scoped>
.review {
  max-width: 720px;
}
.review--wide {
  max-width: 1240px;
}
.review__main {
  display: flex;
  gap: 18px;
  align-items: flex-start;
}
.review__col {
  flex: 1;
  min-width: 0;
}
.review__side {
  width: 280px;
  flex-shrink: 0;
  position: sticky;
  top: 16px;
  max-height: min(78vh, 720px);
  overflow-y: auto;
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 12px 14px;
}
.review__chat {
  width: 380px;
  flex-shrink: 0;
  height: min(72vh, 680px);
  position: sticky;
  top: 16px;
}
button.ghost.active {
  border-color: var(--accent);
  color: var(--accent);
}
.review__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 22px;
}
.status-cluster {
  display: flex;
  align-items: center;
  gap: 10px;
}
.counts {
  display: flex;
  gap: 8px;
  font-size: 12px;
}
.counts__seg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid var(--pageLine);
  border-radius: 999px;
  color: var(--pageMuted);
}
.counts__seg--pile,
.counts__seg--pile b {
  color: var(--accent);
}
.counts__seg--here {
  color: var(--pageInk);
}
.position {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  color: var(--pageMuted);
}
button.ghost {
  background: transparent;
  border: 1px solid var(--pageLine);
  padding: 6px 12px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  color: var(--pageInk);
  letter-spacing: 0.04em;
}
.header-actions {
  display: flex;
  gap: 6px;
}
.newchip {
  font-size: 11px;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--pageLine);
  color: var(--pageMuted);
}
.newchip--new {
  color: var(--accent);
  border-color: var(--accent);
}
.newchip--allknown {
  color: var(--pageMuted);
  opacity: 0.6;
}
.retime {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 12px 14px;
  margin-bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.retime__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.retime__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.retime__hint {
  font-size: 12px;
  color: var(--pageMuted);
}
.retime__progress {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: white;
  padding: 8px 14px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  letter-spacing: 0.04em;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.commit-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0 4px;
}
.commit-btn {
  flex-shrink: 0;
}
.from-here {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accentSoft);
  color: var(--accent);
  font-family: 'Zen Kaku Gothic New', sans-serif;
}
.card {
  background: var(--bBg);
  border: 1px solid var(--bLine);
  border-radius: 8px;
  overflow: hidden;
}
.card__shot {
  aspect-ratio: 16/9;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card__shot img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.card__shot--pending {
  color: var(--bMuted);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.card__body {
  padding: 22px 26px 26px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rule {
  display: flex;
  gap: 8px;
  align-items: center;
}
.rule__bar {
  width: 12px;
  height: 2px;
  background: var(--accent);
}
.rule__label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--bMuted);
}
.sentence {
  font-family: 'Zen Kaku Gothic New', sans-serif;
  font-size: 24px;
  line-height: 1.85;
  color: var(--bInk);
  margin: 0;
}
.translation {
  font-size: 15px;
  line-height: 1.55;
  color: var(--bMuted);
  margin: 0;
  border-left: 2px solid var(--accent);
  padding-left: 10px;
}
audio {
  width: 100%;
}
.note {
  width: 100%;
  resize: vertical;
  background: var(--bPanel);
  border: 1px solid var(--bLine);
  border-radius: 4px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  color: var(--bInk);
  line-height: 1.5;
}
.muted {
  color: var(--pageMuted);
  font-size: 13px;
}
.small {
  font-size: 12px;
}
.err {
  color: #c83a3a;
  font-size: 13px;
}
.tok {
  display: inline-block;
  border-bottom: 2px solid transparent;
  padding-bottom: 1px;
  margin: 1px 0;
  border-radius: 3px;
}
.tok--clickable {
  cursor: pointer;
  transition: background 80ms ease;
}
.tok--clickable:hover {
  background: var(--bPanel);
}
.tok--literal {
  color: var(--bMuted);
}
.tok--picked {
  background: var(--accentSoft);
  color: var(--accent);
}
.tok--known {
  border-bottom-color: rgba(132, 201, 166, 0.35);
}
.tok--learning {
  border-bottom-color: rgba(232, 180, 80, 0.55);
}
.tok--created {
  border-bottom-color: rgba(150, 150, 150, 0.5);
}
.tok--new {
  border-bottom-color: var(--accent);
}
.pile-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pile-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid var(--pageLine);
  border-radius: 4px;
  background: var(--bBg);
}
.pile-item__head {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: baseline;
  gap: 5px;
  color: var(--pageInk);
  font-family: 'Zen Kaku Gothic New', sans-serif;
  text-align: left;
  flex: 1;
  min-width: 0;
}
.pile-item__lemma {
  font-size: 14px;
  font-weight: 600;
}
.pile-item__surface {
  font-size: 11px;
}
.pile-item__meta {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-right: 4px;
}
.pile-item__exported {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--accentSoft);
  color: var(--accent);
}
.pile-item__del {
  background: none;
  border: none;
  color: var(--pageMuted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
}
.pile-item__del:hover {
  color: #c83a3a;
}
h3 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 15px;
  margin: 0;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
</style>
