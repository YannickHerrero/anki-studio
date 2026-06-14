<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { fetchCards, mediaUrl, saveDecisions, type CardSummary, type Decision } from '../api';
import { useSessionStore } from '../stores/session';

const props = defineProps<{ sid: string }>();
const router = useRouter();
const session = useSessionStore();

const index = ref(0);
const loading = ref(true);
const error = ref<string | null>(null);
const audioEl = ref<HTMLAudioElement | null>(null);

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
      <button class="ghost" @click="goExport">Done — Export</button>
    </header>

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
