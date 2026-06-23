<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  addPicks,
  fetchAnalysis,
  fetchCards,
  fetchPicks,
  markWord,
  mediaUrl,
  mergeTokens,
  mergeWithPrevious,
  relinkVideo,
  relinkYoutube,
  removePick,
  streamSse,
  updateCard,
  type CardAnalysis,
  type CardSummary,
  type EditProposal,
  type ManualWordStatus,
  type PickTokenInput,
  type TokenStatus,
  type WordStatus,
} from '../api';
import { useSessionStore } from '../stores/session';
import { useSettingsStore } from '../stores/settings';
import ChatPanel from '../components/ChatPanel.vue';
import MenuDropdown from '../components/MenuDropdown.vue';
import ResizeHandle from '../components/ResizeHandle.vue';
import { useResizable } from '../composables/useResizable';

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

/** Which panel the right column shows. The segmented control in the
 * toolbar toggles it; the 'P' shortcut flips between the two. */
const activeTab = ref<'pile' | 'chat'>('pile');
const merging = ref(false);
const mergeError = ref<string | null>(null);

// Resizable two-column layout. The body element drives the max bounds so
// the columns stay within the available width / height on viewport resize.
// The left column is split vertically into a video pane (top) and a
// workspace card (bottom).
const paneRoot = ref<HTMLElement | null>(null);
const paneWidth = ref(1200);
const paneHeight = ref(720);
const HANDLE_PX = 12;
const MIN_LEFT_PX = 520;
const MIN_RIGHT_PX = 320;
const MIN_VIDEO_PX = 220;
const MIN_WORKSPACE_PX = 220;

const { size: leftPx, dragging: hDragging, start: startHResize, clampToMax: clampLeft } = useResizable({
  key: 'review.leftPx',
  axis: 'x',
  min: MIN_LEFT_PX,
  max: () => Math.max(MIN_LEFT_PX, paneWidth.value - MIN_RIGHT_PX - HANDLE_PX),
  initial: 900,
});

const { size: videoPx, dragging: vDragging, start: startVResize, clampToMax: clampVideo } = useResizable({
  key: 'review.videoPx',
  axis: 'y',
  min: MIN_VIDEO_PX,
  max: () => Math.max(MIN_VIDEO_PX, paneHeight.value - MIN_WORKSPACE_PX - HANDLE_PX),
  initial: 380,
});

const gridCols = computed(() => `${leftPx.value}px ${HANDLE_PX}px 1fr`);
const leftRows = computed(() => `${videoPx.value}px ${HANDLE_PX}px 1fr`);

let paneObserver: ResizeObserver | null = null;
function attachPaneObserver() {
  if (!paneRoot.value) return;
  paneObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      paneWidth.value = entry.contentRect.width;
      paneHeight.value = entry.contentRect.height;
    }
    clampLeft();
    clampVideo();
  });
  paneObserver.observe(paneRoot.value);
}

const refining = ref(false);
const refineProgress = ref<{ done: number; total: number; refined: number; failed: number } | null>(null);
const refineError = ref<string | null>(null);
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

// Token currently under the mouse — used for the 1/0 manual-mark hotkeys.
const hoveredTokenIdx = ref<number | null>(null);

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

/** 0–100 — how far we are through the session (drives the toolbar progress bar). */
const positionPct = computed(() => {
  const total = session.cards.length;
  if (total <= 0) return 0;
  return Math.round(((index.value + 1) / total) * 100);
});

/** "m:ss" duration for the audio button timecode chip. */
const currentDurationLabel = computed(() => {
  const c = current.value;
  if (!c) return '0:00';
  const totalSec = Math.max(0, Math.round((c.endMs - c.startMs) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
});
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

// --- Token merge: click a word, then shift+click the adjacent one to fuse
// them into a single token (e.g. 実用 + 性 → 実用性). The plain click sets the
// anchor; the shift+click on a neighbour merges. ---
const mergeAnchorIdx = ref<number | null>(null);
const mergingTokens = ref(false);

function onTokenClick(tokenIdx: number, e: MouseEvent) {
  if (e.shiftKey) {
    void mergeAtAnchor(tokenIdx);
    return;
  }
  toggleToken(tokenIdx);
  mergeAnchorIdx.value = tokenIdx;
}

async function mergeAtAnchor(tokenIdx: number) {
  const cue = current.value;
  const anchor = mergeAnchorIdx.value;
  // Need an adjacent anchor; otherwise treat this shift+click as the new anchor.
  if (!cue || anchor === null || Math.abs(tokenIdx - anchor) !== 1) {
    mergeAnchorIdx.value = tokenIdx;
    return;
  }
  if (mergingTokens.value) return;
  const lo = Math.min(anchor, tokenIdx);
  const hi = Math.max(anchor, tokenIdx);
  mergingTokens.value = true;
  try {
    await mergeTokens(props.sid, cue.index, lo, hi);
    clearCueSelection(cue.index);
    mergeAnchorIdx.value = null;
    // Token list changed — pull fresh tokens + recomputed word status.
    await loadAnalysis();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    mergingTokens.value = false;
  }
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
    const result = await addPicks(props.sid, cue.index, tokens);
    applyStatusChanges(result.statusChanges);
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
    const result = await removePick(props.sid, pickId);
    applyStatusChanges(result.statusChanges);
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
  else if (e.key === 'p' || e.key === 'P') activeTab.value = activeTab.value === 'pile' ? 'chat' : 'pile';
  else if (e.key === '1') void markHovered('known');
  else if (e.key === '0') void markHovered('ignored');
}

/**
 * Apply a manual status (known / ignored) to whichever token is hovered.
 * Updates every cue's analysis locally so a word marked from cue 5 also
 * reflects in cue 12. Then persists via /known/mark.
 */
async function markHovered(status: ManualWordStatus) {
  const cue = current.value;
  const tokenIdx = hoveredTokenIdx.value;
  const a = currentAnalysis.value;
  if (!cue || tokenIdx === null || !a) return;
  const tok = a.tokens[tokenIdx];
  if (!tok?.lemma) return;
  const lemma = tok.lemma;

  // Optimistic: walk every cue's analysis and apply the new status to all
  // tokens sharing this lemma, recomputing the count fields.
  applyStatusLocally(lemma, status);

  try {
    await markWord(lemma, status, tok.reading);
  } catch (err) {
    // Best-effort recovery — refetch the truth.
    error.value = err instanceof Error ? err.message : String(err);
    void loadAnalysis();
  }
}

/**
 * Apply a batch of lemma → status changes (or null to revert to 'new')
 * across every cue's analysis row. Used after pile add/remove so picked
 * words drop out of `newCount` and pick up the `tok--created` underline
 * without a server round-trip.
 */
function applyStatusChanges(changes: Record<string, WordStatus | null>) {
  if (Object.keys(changes).length === 0) return;
  const next: Record<number, CardAnalysis> = {};
  for (const [k, row] of Object.entries(analysis.value)) {
    const tokens = row.tokens.map((t) => {
      if (!t.lemma || !(t.lemma in changes)) return t;
      const status: TokenStatus = changes[t.lemma] ?? 'new';
      return { ...t, s: status };
    });
    const seen: Record<TokenStatus, Set<string>> = {
      new: new Set<string>(),
      known: new Set<string>(),
      learning: new Set<string>(),
      created: new Set<string>(),
      ignored: new Set<string>(),
    };
    for (const t of tokens) {
      if (!t.lemma || !t.s) continue;
      seen[t.s].add(t.lemma);
    }
    next[Number(k)] = {
      newCount: seen.new.size,
      learningCount: seen.learning.size,
      knownCount: seen.known.size,
      createdCount: seen.created.size,
      tokens,
    };
  }
  analysis.value = next;
}

function applyStatusLocally(lemma: string, status: ManualWordStatus) {
  const next: Record<number, CardAnalysis> = {};
  for (const [k, row] of Object.entries(analysis.value)) {
    const tokens = row.tokens.map((t) => (t.lemma === lemma ? { ...t, s: status } : t));
    // Recount unique lemmas by status. 'ignored' contributes to nothing.
    const seen = {
      new: new Set<string>(),
      known: new Set<string>(),
      learning: new Set<string>(),
      created: new Set<string>(),
      ignored: new Set<string>(),
    };
    for (const t of tokens) {
      if (!t.lemma || !t.s) continue;
      seen[t.s].add(t.lemma);
    }
    next[Number(k)] = {
      newCount: seen.new.size,
      learningCount: seen.learning.size,
      knownCount: seen.known.size,
      createdCount: seen.created.size,
      tokens,
    };
  }
  analysis.value = next;
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
    // The merged cue gets a brand-new index, so the analysis map (keyed by
    // cue index) has no row for it yet — reload or its tokens vanish.
    await loadAnalysis();
    index.value = res.newPosition;
  } catch (err) {
    mergeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    merging.value = false;
  }
}

async function refineTokensWithLlm() {
  if (refining.value) return;
  if (!settings.openrouterKey.trim()) {
    refineError.value = 'set an OpenRouter API key in Settings first';
    return;
  }
  refining.value = true;
  refineError.value = null;
  refineProgress.value = null;
  try {
    await streamSse(
      `/session/${props.sid}/refineTokens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          openrouterKey: settings.openrouterKey.trim(),
          model: settings.model,
        }),
      },
      ({ event, data }) => {
        const d = data as {
          done?: number;
          total?: number;
          refined?: number;
          failed?: number;
          message?: string;
        };
        if (event === 'start') {
          refineProgress.value = {
            done: 0,
            total: d.total ?? 0,
            refined: 0,
            failed: 0,
          };
        } else if (event === 'progress') {
          refineProgress.value = {
            done: d.done ?? 0,
            total: d.total ?? refineProgress.value?.total ?? 0,
            refined: d.refined ?? 0,
            failed: d.failed ?? 0,
          };
        } else if (event === 'error') {
          refineError.value = d.message ?? 'refine failed';
        }
      },
    );
    // Pull the new tokens.
    await loadAnalysis();
  } catch (err) {
    refineError.value = err instanceof Error ? err.message : String(err);
  } finally {
    refining.value = false;
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
  attachPaneObserver();
  session.sessionId = props.sid;
  try {
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    source.value = data.source;
    videoRemoved.value = data.videoRemoved;
    // Wait for picks so we can resume on the cue right after the last one
    // anything was added from. Analysis can keep loading in the background.
    void loadAnalysis();
    await refreshPicks();

    // Smart-resume: focus the first cue whose stable index is greater than
    // the highest-indexed picked cue. If everything's been picked from or
    // there are no picks, leave the cursor at the start.
    if (session.picks.length > 0 && session.cards.length > 0) {
      const lastPickedCueIndex = session.picks.reduce(
        (max, p) => Math.max(max, p.cueIndex),
        -1,
      );
      const nextPos = session.cards.findIndex((c) => c.index > lastPickedCueIndex);
      if (nextPos >= 0) index.value = nextPos;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  if (noteTimer) clearTimeout(noteTimer);
  paneObserver?.disconnect();
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
  <section class="rv">
    <!-- ============ WORK TOOLBAR ============ -->
    <div class="rv-toolbar">
      <div class="rv-toolbar__status">
        <div class="rv-pos">
          <span class="rv-pos__num">{{ index + 1 }}</span>
          <span class="rv-pos__total">/ {{ session.cards.length }}</span>
          <div class="rv-pos__bar"><div class="rv-pos__fill" :style="{ width: positionPct + '%' }"></div></div>
        </div>
        <div class="rv-toolbar__sep"></div>
        <div class="rv-pilecounts">
          <span class="rv-pilecount"><b>{{ session.pileCount }}</b> in pile</span>
          <span
            v-if="currentAnalysis && hasKnownData"
            class="rv-newchip"
            :class="currentAnalysis.newCount === 0 ? 'rv-newchip--allknown' : 'rv-newchip--new'"
          >
            {{ currentAnalysis.newCount === 0 ? 'all known' : `${currentAnalysis.newCount} new` }}
          </span>
        </div>
      </div>

      <div class="rv-toolbar__actions">
        <div class="rv-tabs">
          <button
            class="rv-tab"
            :class="{ 'rv-tab--on': activeTab === 'pile' }"
            @click="activeTab = 'pile'"
          >Pile · {{ session.pileCount }}</button>
          <button
            class="rv-tab"
            :class="{ 'rv-tab--on': activeTab === 'chat' }"
            @click="activeTab = 'chat'"
          >Chat</button>
        </div>
        <MenuDropdown label="Tools">
          <button :disabled="!canMerge" @click="mergePrev">
            {{ merging ? 'Merging…' : 'Merge with previous' }}
          </button>
          <button @click="toggleRetime">Retime</button>
          <button :disabled="refining" @click="refineTokensWithLlm">
            {{
              refining
                ? `Refining ${refineProgress?.done ?? 0}/${refineProgress?.total ?? '?'}…`
                : 'Refine tokens with LLM'
            }}
          </button>
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
        <button class="rv-export" @click="goExport">Done — Export</button>
      </div>
    </div>

    <!-- Status / error strip -->
    <div
      v-if="mergeError || refineError || (refineProgress && !refining && (refineProgress.refined > 0 || refineProgress.failed > 0))"
      class="rv-status-strip"
    >
      <span v-if="mergeError" class="rv-err">{{ mergeError }}</span>
      <span v-if="refineError" class="rv-err">{{ refineError }}</span>
      <span
        v-if="refineProgress && !refining && (refineProgress.refined > 0 || refineProgress.failed > 0)"
        class="rv-muted"
      >
        Refined {{ refineProgress.refined }} cues
        <span v-if="refineProgress.failed > 0">· {{ refineProgress.failed }} fell back to kuromoji</span>
      </span>
    </div>

    <!-- ============ RELINK PANEL (Tools → Re-link path) ============ -->
    <div v-if="showRelink" class="rv-banner">
      <input
        ref="fileInput"
        type="file"
        accept="video/*,.mkv"
        style="display: none"
        @change="onFilePicked"
      />
      <div class="rv-banner__row">
        <span class="rv-banner__label">Re-link</span>
        <span class="rv-banner__hint">
          Retiming and merging re-cut from the source video, which was freed. Re-link it to continue.
        </span>
      </div>
      <div class="rv-banner__row">
        <button
          v-if="source === 'youtube'"
          class="rv-primary"
          :disabled="relinking"
          @click="relinkFromYoutube"
        >
          {{ relinking ? `Downloading ${relinkProgress}%…` : 'Re-download from YouTube' }}
        </button>
        <button v-else class="rv-primary" :disabled="relinking" @click="chooseFile">
          {{ relinking ? 'Linking…' : 'Choose video file…' }}
        </button>
        <button class="rv-ghost" :disabled="relinking" @click="showRelink = false">Cancel</button>
      </div>
      <div v-if="relinkMismatch" class="rv-banner__hint" style="color: #c83a3a">
        Warning: this file's duration differs from the original — re-cuts may be misaligned.
        It's been linked anyway; use only if you're sure it's the same video.
      </div>
      <div v-if="relinkError" class="rv-err">{{ relinkError }}</div>
    </div>

    <!-- ============ RETIME PANEL ============ -->
    <div v-if="showRetime" class="rv-banner">
      <div class="rv-banner__row">
        <label class="rv-banner__label">Shift</label>
        <input
          v-model.number="retimeSeconds"
          type="number"
          step="0.05"
          placeholder="seconds"
          :disabled="retiming"
          class="rv-banner__input"
        />
        <span class="rv-banner__hint">seconds — positive delays, negative advances</span>
      </div>
      <div class="rv-banner__row">
        <button class="rv-primary" :disabled="!retimeSeconds || retiming" @click="retime('all')">
          Apply to all
        </button>
        <button
          class="rv-primary"
          :disabled="!retimeSeconds || retiming"
          @click="retime('from-here')"
        >
          Apply from here onwards
        </button>
        <button class="rv-ghost" :disabled="retiming" @click="showRetime = false">Cancel</button>
      </div>
      <div v-if="retiming || retimeTotal" class="rv-banner__hint">
        Re-cutting {{ retimeDone }} / {{ retimeTotal }}
      </div>
      <div v-if="retimeError" class="rv-err">{{ retimeError }}</div>
    </div>

    <!-- ============ BODY (resizable 2-col + nested top/bottom split) ============ -->
    <div
      ref="paneRoot"
      class="rv-body"
      :style="{ gridTemplateColumns: gridCols }"
    >
      <!-- LEFT COLUMN: video + workspace -->
      <div class="rv-left" :style="{ gridTemplateRows: leftRows }">
        <!-- Video pane (dressed screenshot) -->
        <div class="rv-video">
          <div class="rv-video__inner">
            <div class="rv-frame">
              <img
                v-if="current && current.screenshotReady"
                :src="mediaUrl(current.screenshotUrl)"
                alt="frame"
                class="rv-frame__img"
              />
              <div v-else class="rv-frame__pending">screenshot not ready</div>
              <div v-if="current" class="rv-frame__chip">{{ currentDurationLabel }}</div>
            </div>
          </div>
        </div>

        <ResizeHandle axis="y" :active="vDragging" @start="startVResize" />

        <!-- Workspace card -->
        <div class="rv-workspace">
          <div class="rv-card">
            <p v-if="loading" class="rv-muted">Loading…</p>
            <p v-else-if="error" class="rv-err">{{ error }}</p>
            <p v-else-if="!current" class="rv-muted">No cards.</p>
            <template v-else>
              <div class="rv-rule">
                <span class="rv-rule__bar"></span><span class="rv-rule__label">Sentence</span>
              </div>

              <!-- Interactive tokenized sentence -->
              <p class="rv-sentence" v-if="currentAnalysis">
                <span
                  v-for="(tok, i) in currentAnalysis.tokens"
                  :key="i"
                  class="tok"
                  :class="[
                    tok.s && settings.underlineByStatus ? `tok--${tok.s}` : '',
                    currentSelection.has(i) ? 'tok--picked' : '',
                    tok.lemma ? 'tok--content' : 'tok--literal',
                    hoveredTokenIdx === i ? 'tok--hovered' : '',
                    mergeAnchorIdx === i ? 'tok--merge-anchor' : '',
                  ]"
                  title="Click to pick · Shift+click an adjacent word to merge"
                  @click="onTokenClick(i, $event)"
                  @mouseenter="hoveredTokenIdx = i"
                  @mouseleave="hoveredTokenIdx === i ? (hoveredTokenIdx = null) : null"
                >{{ tok.t }}</span>
              </p>
              <p class="rv-sentence rv-sentence--plain" v-else>{{ current.text }}</p>

              <div v-if="current.translation" class="rv-translation">
                <span class="rv-translation__rail"></span>
                <span class="rv-translation__text">{{ current.translation }}</span>
              </div>

              <div class="rv-action-row">
                <button
                  class="rv-audio"
                  :disabled="!current.audioReady"
                  title="Play line audio (Space)"
                  @click="replay"
                >
                  <span class="rv-audio__disc">
                    <span class="rv-audio__triangle"></span>
                  </span>
                  <span class="rv-audio__time">{{ currentDurationLabel }}</span>
                </button>
                <button
                  class="rv-commit"
                  :disabled="selectedCount === 0"
                  @click="commitPicks"
                >
                  {{ selectedCount === 0
                    ? '＋ Click words to add'
                    : `＋ Add ${selectedCount} card${selectedCount === 1 ? '' : 's'} to pile (A)` }}
                </button>
                <span v-if="picksForCurrentCue.length > 0" class="rv-muted rv-from-here">
                  Already added:
                  <span class="rv-from-here__chip" v-for="p in picksForCurrentCue" :key="p.id">{{ p.lemma }}</span>
                </span>
              </div>
              <div class="rv-hover-hint">
                Hover a word and press <kbd>1</kbd> to mark it known · <kbd>0</kbd> to ignore it
              </div>

              <!-- Hidden audio element — the visible button drives it. -->
              <audio
                v-if="current.audioReady"
                ref="audioEl"
                :src="mediaUrl(current.audioUrl)"
                autoplay
                class="rv-audio__el"
              />
            </template>
          </div>
        </div>
      </div>

      <ResizeHandle axis="x" :active="hDragging" @start="startHResize" />

      <!-- RIGHT COLUMN: tabbed panel + note -->
      <div class="rv-right">
        <div class="rv-panel">
          <!-- PILE TAB -->
          <template v-if="activeTab === 'pile'">
            <div class="rv-panel__head">
              <div class="rv-panel__title">
                <span>Pile</span>
                <span class="rv-panel__count">{{ session.pileCount }} cards</span>
              </div>
            </div>
            <div class="rv-panel__body rv-panel__body--pile">
              <p v-if="session.picks.length === 0" class="rv-muted">
                Empty — click words in any sentence and press A.
              </p>
              <ul v-else class="rv-pile">
                <li v-for="p in session.picks" :key="p.id" class="rv-pile__row">
                  <button
                    class="rv-pile__head"
                    @click="index = session.cards.findIndex((c) => c.index === p.cueIndex)"
                  >
                    <span class="rv-pile__surface">{{ p.surface }}</span>
                    <span v-if="p.surface !== p.lemma" class="rv-pile__lemma">→ {{ p.lemma }}</span>
                  </button>
                  <span class="rv-pile__cue">CUE #{{ p.cueIndex }}</span>
                  <span v-if="p.exported" class="rv-pile__exported">exported</span>
                  <button class="rv-pile__x" title="Remove from pile" @click="removeFromPile(p.id)">×</button>
                </li>
              </ul>
            </div>
          </template>

          <!-- CHAT TAB -->
          <div v-else-if="activeTab === 'chat' && current" class="rv-panel__chat">
            <ChatPanel :sid="sid" :card="current" @apply="applyEdit" />
          </div>
        </div>

        <!-- NOTE PANEL -->
        <div v-if="current" class="rv-note">
          <div class="rv-rule">
            <span class="rv-rule__bar"></span>
            <span class="rv-rule__label">Note</span>
            <span class="rv-note__hint">· shared by every card from this cue</span>
          </div>
          <textarea
            v-model="noteDraft"
            class="rv-note__input"
            placeholder="Add a note…"
            @input="scheduleNoteSave"
          ></textarea>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ============ Design tokens (scoped to .rv) ============ */
.rv {
  --panel: #ffffff;
  --ink: #2c2925;
  --muted: #98948b;
  --faint: #bdb9af;
  --line: #e7e3d9;
  --lineSoft: #f0ece3;
  --accentSoft: #eaf2ec;
  --sage: #8aa98e;
  --sageInk: #33513c;
  --videoBg: #15140f;

  display: flex;
  flex-direction: column;
  width: 100%;
  /* Fill viewport below the app-header (.app-header is 57px including its
     1px border; .app-main--full removes all padding for this route). */
  height: calc(100dvh - 57px);
  min-height: 540px;
  overflow: hidden;
  background: var(--page);
  color: var(--ink);
  font-family: 'Zen Kaku Gothic New', sans-serif;
}
@media (prefers-color-scheme: dark) {
  .rv {
    --panel: #1c1f24;
    --ink: var(--pageInk);
    --muted: var(--pageMuted);
    --faint: #4b4a44;
    --line: #2a2b30;
    --lineSoft: #1f2024;
    --accentSoft: rgba(132, 201, 166, 0.13);
    --videoBg: #0c0c0e;
  }
}

/* ============ Work toolbar ============ */
.rv-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 22px;
  height: 52px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.rv-toolbar__status {
  display: flex;
  align-items: center;
  gap: 18px;
}
.rv-toolbar__sep {
  width: 1px;
  height: 20px;
  background: var(--line);
}
.rv-pos {
  display: flex;
  align-items: center;
  gap: 9px;
}
.rv-pos__num {
  font-family: 'Newsreader', serif;
  font-size: 15px;
  color: var(--ink);
}
.rv-pos__total {
  font-size: 12px;
  color: var(--faint);
}
.rv-pos__bar {
  width: 118px;
  height: 4px;
  border-radius: 3px;
  background: var(--lineSoft);
  overflow: hidden;
}
.rv-pos__fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 180ms ease;
}
.rv-pilecounts {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ink);
}
.rv-pilecount b {
  font-weight: 700;
}
.rv-newchip {
  font-size: 11px;
  color: var(--accent);
  background: var(--accentSoft);
  border-radius: 999px;
  padding: 2px 9px;
}
.rv-newchip--allknown {
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
}
.rv-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rv-tabs {
  display: flex;
  background: var(--lineSoft);
  border-radius: 8px;
  padding: 3px;
  gap: 2px;
}
.rv-tab {
  all: unset;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 6px;
  color: var(--muted);
  transition: all 120ms ease;
}
.rv-tab--on {
  background: var(--panel);
  color: var(--ink);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.rv-export {
  all: unset;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border-radius: 8px;
  padding: 9px 18px;
}
.rv-export:hover {
  filter: brightness(0.95);
}

/* MenuDropdown comes from a shared component — these neutralise its
   default chrome so it fits the toolbar's height + radius. */
.rv-toolbar :deep(.menu),
.rv-toolbar :deep(.menu__trigger) {
  font-size: 13px;
}
.rv-toolbar :deep(.menu__trigger) {
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 14px;
  color: var(--ink);
  font-family: inherit;
}

/* ============ Inline status strip (errors / refine progress) ============ */
.rv-status-strip {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 22px;
  font-size: 13px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

/* ============ Banners (retime / re-link) ============ */
.rv-banner {
  flex: 0 0 auto;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 12px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rv-banner__row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.rv-banner__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--muted);
}
.rv-banner__hint {
  font-size: 12px;
  color: var(--muted);
}
.rv-banner__input {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--ink);
  font-family: inherit;
}
.rv-primary {
  all: unset;
  cursor: pointer;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  padding: 8px 16px;
}
.rv-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rv-ghost {
  all: unset;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 14px;
}

/* ============ Body grid (resizable 2-col) ============ */
.rv-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  padding: 16px;
  gap: 0;
}
.rv-left {
  display: grid;
  min-width: 0;
  min-height: 0;
}
.rv-right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  min-height: 0;
}

/* ============ Video pane ============ */
.rv-video {
  min-height: 0;
  display: flex;
}
.rv-video__inner {
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--videoBg);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  align-items: center;
  justify-content: center;
}
.rv-frame {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Hatched fallback only shows when no screenshot is loaded. */
  background-image: repeating-linear-gradient(135deg, #23211a 0 1px, transparent 1px 14px);
}
.rv-frame__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rv-frame__pending {
  color: #6f6a5c;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.rv-frame__chip {
  position: absolute;
  top: 12px;
  left: 12px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: #e8e4d8;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 6px;
  padding: 3px 8px;
}
/* ============ Workspace card ============ */
.rv-workspace {
  min-height: 0;
  overflow: auto;
}
.rv-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rv-rule {
  display: flex;
  gap: 8px;
  align-items: center;
}
.rv-rule__bar {
  width: 13px;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}
.rv-rule__label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--muted);
}
.rv-sentence {
  font-family: 'Shippori Mincho', serif;
  font-weight: 500;
  font-size: 22px;
  line-height: 1.85;
  color: var(--ink);
  margin: 0;
}
.rv-sentence--plain {
  font-family: 'Shippori Mincho', serif;
}
.rv-translation {
  display: flex;
  gap: 11px;
  margin-top: 4px;
}
.rv-translation__rail {
  flex: 0 0 auto;
  width: 2px;
  background: var(--accent);
  border-radius: 2px;
}
.rv-translation__text {
  font-family: 'Newsreader', serif;
  font-size: 17px;
  line-height: 1.5;
  color: var(--ink);
}
.rv-action-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.rv-audio {
  all: unset;
  cursor: pointer;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  background: var(--lineSoft);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 14px 8px 9px;
}
.rv-audio:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rv-audio__disc {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.rv-audio__triangle {
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 5px 0 5px 8px;
  border-color: transparent transparent transparent #fff;
  margin-left: 2px;
}
.rv-audio__time {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--muted);
}
.rv-audio__el {
  display: none;
}
.rv-commit {
  all: unset;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--sageInk);
  background: var(--accentSoft);
  border: 1px solid #cfe0d4;
  border-radius: 8px;
  padding: 9px 16px;
}
.rv-commit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.rv-from-here {
  font-size: 12px;
}
.rv-from-here__chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accentSoft);
  color: var(--accent);
}
.rv-hover-hint {
  margin-top: -2px;
  font-size: 12px;
  color: var(--muted);
}
.rv-hover-hint kbd {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  background: var(--lineSoft);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 1px 5px;
  margin: 0 2px;
}

/* ============ Tokens (interactive sentence) ============ */
.tok {
  display: inline-block;
  border-bottom: 2px solid transparent;
  padding: 1px 2px;
  margin: 1px 0;
  border-radius: 3px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.tok:hover {
  background: var(--accentSoft);
}
.tok--literal {
  color: var(--faint);
}
.tok--picked {
  background: var(--accentSoft);
  color: var(--accent);
}
.tok--known {
  border-bottom-color: rgba(132, 201, 166, 0.5);
}
.tok--learning {
  border-bottom-color: rgba(232, 180, 80, 0.65);
}
.tok--created {
  border-bottom-color: rgba(150, 150, 150, 0.55);
}
.tok--new {
  border-bottom-color: var(--accent);
}
.tok--ignored {
  border-bottom-color: transparent;
  color: var(--faint);
}
.tok--hovered {
  background: var(--lineSoft);
}
/* Anchor for a pending shift+click merge. */
.tok--merge-anchor {
  outline: 1px dashed var(--accent);
  outline-offset: 1px;
}

/* ============ Right column: panel + note ============ */
.rv-panel {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
}
.rv-panel__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--line);
}
.rv-panel__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 16px;
}
.rv-panel__count {
  font-family: 'Zen Kaku Gothic New', sans-serif;
  font-weight: 400;
  font-size: 12px;
  color: var(--muted);
}
.rv-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
.rv-panel__body--pile {
  padding: 6px 10px;
}
.rv-panel__body .rv-muted {
  padding: 18px 12px;
}
.rv-panel__chat {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rv-panel__chat > * {
  flex: 1 1 auto;
  min-height: 0;
}

/* ============ Pile ============ */
.rv-pile {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}
.rv-pile__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border-radius: 8px;
  transition: background 120ms ease;
}
.rv-pile__row:hover {
  background: var(--lineSoft);
}
.rv-pile__head {
  all: unset;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 9px;
  cursor: pointer;
}
.rv-pile__surface {
  font-family: 'Zen Kaku Gothic New', sans-serif;
  font-weight: 700;
  font-size: 16px;
  color: var(--ink);
}
.rv-pile__lemma {
  font-size: 12px;
  color: var(--muted);
}
.rv-pile__cue {
  flex: 0 0 auto;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--faint);
  letter-spacing: 0.02em;
}
.rv-pile__exported {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accentSoft);
  border-radius: 5px;
  padding: 2px 8px;
}
.rv-pile__x {
  all: unset;
  flex: 0 0 auto;
  cursor: pointer;
  color: var(--muted);
  font-size: 15px;
  line-height: 1;
  opacity: 0.45;
  transition: opacity 120ms ease, color 120ms ease;
  padding: 0 4px;
}
.rv-pile__x:hover {
  opacity: 1;
  color: #c83a3a;
}

/* ============ Note panel ============ */
.rv-note {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 11px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
}
.rv-note__hint {
  font-size: 11px;
  color: var(--faint);
}
.rv-note__input {
  width: 100%;
  height: 64px;
  resize: none;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 13px;
  font-family: inherit;
  font-size: 14px;
  color: var(--ink);
  background: var(--panel);
  outline: none;
}
.rv-note__input:focus {
  border-color: var(--accent);
}

/* ============ Misc ============ */
.rv-muted {
  color: var(--muted);
  font-size: 13px;
}
.rv-err {
  color: #c83a3a;
  font-size: 13px;
}
</style>
