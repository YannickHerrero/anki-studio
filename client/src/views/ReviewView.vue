<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  fetchCards,
  mediaUrl,
  mergeWithPrevious,
  saveDecisions,
  streamSse,
  type CardSummary,
  type Decision,
} from '../api';
import { useSessionStore } from '../stores/session';

const props = defineProps<{ sid: string }>();
const router = useRouter();
const session = useSessionStore();

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

const merging = ref(false);
const mergeError = ref<string | null>(null);
const canMerge = computed(() => index.value > 0 && !!current.value && !merging.value);

const current = computed<CardSummary | undefined>(() => session.cards[index.value]);
const currentDecision = computed<Decision | undefined>(() =>
  current.value ? session.decisions[current.value.index] : undefined,
);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveDecisions(props.sid, session.decisions);
  }, 400);
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

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  session.sessionId = props.sid;
  try {
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    session.decisions = { ...data.decisions };
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
});

function goExport() {
  router.push({ name: 'export', params: { sid: props.sid } });
}
</script>

<template>
  <section class="review">
    <header class="review__header">
      <div class="counts">
        <span class="counts__item counts__item--kept">{{ session.keptCount }} keep</span>
        <span class="counts__item counts__item--skipped">{{ session.skippedCount }} skip</span>
        <span class="counts__item">{{ session.remainingCount }} left</span>
      </div>
      <div class="position">{{ index + 1 }} / {{ session.cards.length }}</div>
      <div class="header-actions">
        <button class="ghost" :disabled="!canMerge" @click="mergePrev">
          {{ merging ? 'Merging…' : 'Merge with previous' }}
        </button>
        <button class="ghost" @click="showRetime = !showRetime">Retime</button>
        <button class="ghost" @click="goExport">Done — Export</button>
      </div>
    </header>
    <p v-if="mergeError" class="err">{{ mergeError }}</p>

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
        <p class="sentence">{{ current.text }}</p>
        <p v-if="current.translation" class="translation">{{ current.translation }}</p>
        <audio
          v-if="current.audioReady"
          ref="audioEl"
          :src="mediaUrl(current.audioUrl)"
          autoplay
          controls
        />
        <p v-else class="muted">audio not ready</p>

        <div
          v-if="currentDecision"
          class="state"
          :class="currentDecision === 'keep' ? 'state--keep' : 'state--skip'"
        >
          {{ currentDecision === 'keep' ? 'KEEP' : 'SKIP' }}
        </div>
      </div>
    </article>
  </section>
</template>

<style scoped>
.review {
  max-width: 720px;
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
