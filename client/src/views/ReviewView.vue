<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  fetchAnalysis,
  fetchCards,
  mediaUrl,
  mergeWithPrevious,
  relinkVideo,
  relinkYoutube,
  saveDecisions,
  streamSse,
  updateCard,
  type CardAnalysis,
  type CardSummary,
  type Decision,
  type EditProposal,
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
const currentDecision = computed<Decision | undefined>(() =>
  current.value ? session.decisions[current.value.index] : undefined,
);

const analysis = ref<Record<number, CardAnalysis>>({});
const currentAnalysis = computed<CardAnalysis | undefined>(() =>
  current.value ? analysis.value[current.value.index] : undefined,
);
// Only highlight once there's a known-words list to compare against.
const hasKnownData = computed(() =>
  Object.values(analysis.value).some(
    (a) => a.knownCount + a.learningCount + a.createdCount > 0,
  ),
);

async function loadAnalysis() {
  try {
    analysis.value = await fetchAnalysis(props.sid);
  } catch {
    // analysis is a nice-to-have; ignore if the tokenizer/known list isn't ready
  }
}

function autoSkipKnown() {
  let skipped = 0;
  for (const card of session.cards) {
    const a = analysis.value[card.index];
    if (a && a.newCount === 0 && session.decisions[card.index] !== 'skip') {
      session.decisions[card.index] = 'skip';
      skipped++;
    }
  }
  if (skipped > 0) {
    scheduleSave();
    next();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveDecisions(props.sid, session.decisions);
  }, 400);
}

const noteDraft = ref('');
let noteTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNoteSave() {
  const card = current.value;
  if (!card) return;
  if (noteTimer) clearTimeout(noteTimer);
  const value = noteDraft.value;
  noteTimer = setTimeout(() => {
    card.note = value;
    void updateCard(props.sid, card.index, { note: value });
  }, 500);
}

function decide(d: Decision) {
  const card = current.value;
  if (!card) return;
  session.decisions[card.index] = d;
  scheduleSave();
  next();
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

function onKey(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'k' || e.key === 'K') decide('keep');
  else if (e.key === 's' || e.key === 'S') decide('skip');
  else if (e.key === 'ArrowRight') next();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.code === 'Space') {
    e.preventDefault();
    replay();
  } else if (e.key === 'm' || e.key === 'M') {
    void mergePrev();
  }
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
    // Position returned by the server points at the merged card in the new list.
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
    // Refetch so we get updated rev (which cache-busts audio/screenshot URLs).
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    // Force a re-render of the audio/img by nudging the index ref.
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
  // autoplay on card change
  if (audioEl.value) {
    audioEl.value.currentTime = 0;
    audioEl.value.play().catch(() => undefined);
  }
});

watch(
  current,
  (card) => {
    if (noteTimer) clearTimeout(noteTimer);
    noteDraft.value = card?.note ?? '';
  },
  { immediate: true },
);

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  session.sessionId = props.sid;
  try {
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    session.decisions = { ...data.decisions };
    source.value = data.source;
    videoRemoved.value = data.videoRemoved;
    void loadAnalysis();
    // jump to first undecided
    const firstUndecided = data.cards.findIndex((c) => !data.decisions[c.index]);
    if (firstUndecided >= 0) index.value = firstUndecided;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  if (saveTimer) clearTimeout(saveTimer);
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
  const card = current.value;
  if (!card) return;
  try {
    const updated = await updateCard(props.sid, card.index, edit);
    card.text = updated.text;
    card.translation = updated.translation;
    card.note = updated.note;
    noteDraft.value = updated.note ?? '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function goExport() {
  router.push({ name: 'export', params: { sid: props.sid } });
}
</script>

<template>
  <section class="review" :class="{ 'review--wide': showChat }">
    <header class="review__header">
      <div class="counts">
        <span class="counts__item counts__item--kept">{{ session.keptCount }} keep</span>
        <span class="counts__item counts__item--skipped">{{ session.skippedCount }} skip</span>
        <span class="counts__item">{{ session.remainingCount }} left</span>
        <span
          v-if="currentAnalysis && hasKnownData"
          class="counts__item"
          :class="currentAnalysis.newCount === 0 ? 'counts__item--allknown' : 'counts__item--new'"
        >
          {{ currentAnalysis.newCount === 0 ? 'all known' : `${currentAnalysis.newCount} new` }}
        </span>
      </div>
      <div class="position">{{ index + 1 }} / {{ session.cards.length }}</div>
      <div class="header-actions">
        <button class="ghost" :class="{ active: showChat }" @click="showChat = !showChat">
          Chat
        </button>
        <MenuDropdown label="Tools">
          <button :disabled="!canMerge" @click="mergePrev">
            {{ merging ? 'Merging…' : 'Merge with previous' }}
          </button>
          <button @click="toggleRetime">Retime</button>
          <button v-if="hasKnownData" @click="autoSkipKnown">Skip known cards</button>
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
        <button
          class="primary"
          :disabled="!retimeSeconds || retiming"
          @click="retime('all')"
        >
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

    <div class="review__main" :class="{ 'review__main--chat': showChat }">
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
        <p class="sentence">
          <template v-if="currentAnalysis && hasKnownData && settings.underlineByStatus">
            <span
              v-for="(tok, i) in currentAnalysis.tokens"
              :key="i"
              :class="tok.s ? `tok tok--${tok.s}` : undefined"
              >{{ tok.t }}</span
            >
          </template>
          <template v-else>{{ current.text }}</template>
        </p>
        <p v-if="current.translation" class="translation">{{ current.translation }}</p>
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
          placeholder="Add a note for this card (saved to Anki)…"
          @input="scheduleNoteSave"
        ></textarea>

        <div
          v-if="currentDecision"
          class="state"
          :class="currentDecision === 'keep' ? 'state--keep' : 'state--skip'"
        >
          {{ currentDecision === 'keep' ? 'KEEP' : 'SKIP' }}
        </div>
      </div>
    </article>
    </div>
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
  max-width: 1140px;
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
.header-actions {
  display: flex;
  gap: 8px;
}
.retime {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 14px 16px;
  margin-bottom: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.retime__row input[type='number'] {
  background: var(--bPanel);
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  padding: 6px 10px;
  font-size: 14px;
  font-family: ui-monospace, monospace;
  color: var(--pageInk);
  width: 110px;
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
  font-size: 12px;
  cursor: pointer;
  letter-spacing: 0.04em;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.counts {
  display: flex;
  gap: 10px;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.counts__item {
  padding: 4px 9px;
  border: 1px solid var(--pageLine);
  border-radius: 999px;
  color: var(--pageMuted);
}
.counts__item--kept {
  color: var(--accent);
  border-color: var(--accent);
}
.counts__item--skipped {
  color: #c83a3a;
}
.counts__item--new {
  color: #c8902a;
  border-color: #c8902a;
}
.counts__item--allknown {
  color: var(--pageMuted);
}
.position {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  color: var(--pageMuted);
}
button.ghost {
  background: transparent;
  border: 1px solid var(--pageLine);
  padding: 8px 14px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  color: var(--pageInk);
  letter-spacing: 0.06em;
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
  line-height: 1.7;
  color: var(--bInk);
  margin: 0;
}
/* Underline content words by status; known words are left unmarked. */
.tok {
  text-decoration-line: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 4px;
}
.tok--known {
  text-decoration-line: none;
}
.tok--learning {
  text-decoration-color: #e0922a;
}
.tok--created {
  text-decoration-color: #9aa0a6;
}
.tok--new {
  text-decoration-color: #d64545;
}
.translation {
  font-size: 15px;
  line-height: 1.55;
  color: var(--bMuted);
  margin: 0;
  border-left: 2px solid var(--accent);
  padding-left: 10px;
}
.note {
  width: 100%;
  background: var(--bPanel);
  border: 1px solid var(--bLine);
  border-radius: 5px;
  padding: 8px 10px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--bInk);
  font-family: inherit;
  resize: vertical;
}
audio {
  width: 100%;
}
.state {
  align-self: flex-start;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  letter-spacing: 0.18em;
}
.state--keep {
  background: var(--accent);
  color: white;
}
.state--skip {
  background: #c83a3a;
  color: white;
}
.muted {
  color: var(--pageMuted);
  font-size: 13px;
}
.err {
  color: #c83a3a;
  font-size: 13px;
}
</style>
