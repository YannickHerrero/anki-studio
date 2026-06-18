<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { streamSse } from '../api';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{ sid: string }>();
const router = useRouter();
const route = useRoute();
const settings = useSettingsStore();

type Phase =
  | 'idle'
  | 'transcribe'
  | 'refine'
  | 'align'
  | 'cut'
  | 'translate'
  | 'tokenize'
  | 'done';
const phase = ref<Phase>('idle');
const alignStats = ref<{ aligned: number; skipped: number } | null>(null);
const alignStage = ref<'extracting' | 'transcribing' | 'matching' | ''>('');
const shouldAlign = computed(() => route.query.align === '1');

const total = ref(0);
const audioDone = ref(0);
const screenshotDone = ref(0);
const error = ref<string | null>(null);
const audioExtractStage = ref<'extracting' | 'done' | ''>('');
const tokenizeDone = ref(0);
const tokenizeTotal = ref(0);

const cutPct = computed(() => {
  if (!total.value) return 0;
  return Math.round(((audioDone.value + screenshotDone.value) / (2 * total.value)) * 100);
});

const overallPct = computed(() => {
  switch (phase.value) {
    case 'transcribe':
      return 20;
    case 'refine':
      return 30;
    case 'align':
      return 30;
    case 'cut':
      return 40 + Math.round(cutPct.value * 0.35);
    case 'translate':
      return 80;
    case 'tokenize':
      return tokenizeTotal.value
        ? 85 + Math.round((tokenizeDone.value / tokenizeTotal.value) * 14)
        : 90;
    case 'done':
      return 100;
    default:
      return 0;
  }
});

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'transcribe':
      return audioExtractStage.value === 'extracting'
        ? 'Extracting audio for Whisper…'
        : 'Transcribing with Whisper…';
    case 'refine':
      return 'Refining sentence splits with LLM…';
    case 'align':
      switch (alignStage.value) {
        case 'extracting':
          return 'Extracting audio for Whisper…';
        case 'transcribing':
          return 'Transcribing with Whisper to align subtitles…';
        case 'matching':
          return 'Matching subtitle lines to Whisper words…';
        default:
          return 'Aligning subtitles to audio…';
      }
    case 'cut':
      return `Cutting clips — audio ${audioDone.value}/${total.value}, screenshots ${screenshotDone.value}/${total.value}`;
    case 'translate':
      return 'Translating subtitles in whole-transcript context…';
    case 'tokenize':
      return tokenizeTotal.value
        ? `Refining word boundaries with LLM — ${tokenizeDone.value}/${tokenizeTotal.value}…`
        : 'Refining word boundaries with LLM…';
    case 'done':
      return 'Done.';
    default:
      return '';
  }
});

async function ensureTranscript() {
  // Read session state to decide whether we need to transcribe.
  const res = await fetch(`/api/session/${props.sid}`);
  if (!res.ok) throw new Error(`session lookup failed: ${res.status}`);
  const info = (await res.json()) as { cueCount: number };
  if (info.cueCount > 0) return;

  if (!settings.openaiKey.trim()) {
    throw new Error('this session has no subtitles and no OpenAI key is configured');
  }

  // 1a. Transcribe with Whisper (extracts full audio first if missing).
  phase.value = 'transcribe';
  await streamSse(
    `/session/${props.sid}/transcribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openaiKey: settings.openaiKey.trim() }),
    },
    ({ event, data }) => {
      const d = data as { stage?: string; message?: string };
      if (event === 'audio') audioExtractStage.value = (d.stage as 'extracting' | 'done') ?? '';
      else if (event === 'error') throw new Error(d.message ?? 'transcription failed');
    },
  );

  // 1b. Refine sentence splits with LLM — best-effort.
  phase.value = 'refine';
  try {
    await streamSse(
      `/session/${props.sid}/refineSplits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          openrouterKey: settings.openrouterKey.trim(),
          model: settings.model,
        }),
      },
      ({ event, data }) => {
        const d = data as { message?: string };
        if (event === 'error') throw new Error(d.message ?? 'refine failed');
      },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('split refinement failed, keeping heuristic cues:', err);
  }
}

async function alignSubtitles() {
  if (!shouldAlign.value) return;
  if (!settings.openaiKey.trim()) {
    throw new Error('alignment requested but no OpenAI key is configured');
  }
  phase.value = 'align';
  try {
    await streamSse(
      `/session/${props.sid}/align`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiKey: settings.openaiKey.trim() }),
      },
      ({ event, data }) => {
        const d = data as {
          stage?: string;
          aligned?: number;
          skipped?: number;
          message?: string;
        };
        if (event === 'audio') alignStage.value = 'extracting';
        else if (event === 'whisper') alignStage.value = 'transcribing';
        else if (event === 'align') alignStage.value = 'matching';
        else if (event === 'done') {
          alignStats.value = { aligned: d.aligned ?? 0, skipped: d.skipped ?? 0 };
        } else if (event === 'error') throw new Error(d.message ?? 'alignment failed');
      },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('alignment failed, keeping original cue timings:', err);
  }
}

onMounted(async () => {
  try {
    // 0a. If the session has no cues yet (no subtitle was uploaded), transcribe.
    await ensureTranscript();

    // 0b. If the user asked to re-time existing subs, do that next.
    await alignSubtitles();

    // 1. Cut per-cue audio + screenshots.
    phase.value = 'cut';
    await streamSse(
      `/session/${props.sid}/process`,
      { method: 'POST' },
      ({ event, data }) => {
        const d = data as { total?: number; done?: number; kind?: string; message?: string };
        if (event === 'start') total.value = d.total ?? 0;
        else if (event === 'progress' && d.kind === 'audio') audioDone.value = d.done ?? 0;
        else if (event === 'progress' && d.kind === 'screenshot')
          screenshotDone.value = d.done ?? 0;
        else if (event === 'error') throw new Error(d.message ?? 'processing failed');
      },
    );

    // 2. Translate the whole transcript in one OpenRouter call. Best-effort —
    // a translation failure shouldn't block review.
    if (settings.isConfigured) {
      phase.value = 'translate';
      try {
        await streamSse(
          `/session/${props.sid}/translate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              openrouterKey: settings.openrouterKey.trim(),
              model: settings.model,
            }),
          },
          ({ event, data }) => {
            const d = data as { message?: string };
            if (event === 'error') throw new Error(d.message ?? 'translation failed');
          },
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('translation failed, continuing to review without it:', err);
      }

      // 3. LLM-refine tokenization so 食べました / ありがとうございます /
      // 4月 / etc. arrive in the review as single tokens with correct
      // lemmas. Best-effort: cues that fail fall back to kuromoji.
      phase.value = 'tokenize';
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
              total?: number;
              done?: number;
              message?: string;
            };
            if (event === 'start') tokenizeTotal.value = d.total ?? 0;
            else if (event === 'progress') {
              tokenizeDone.value = d.done ?? 0;
              if (typeof d.total === 'number') tokenizeTotal.value = d.total;
            } else if (event === 'error') throw new Error(d.message ?? 'tokenize failed');
          },
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('token refinement failed, keeping kuromoji tokens:', err);
      }
    }

    phase.value = 'done';
    router.replace({ name: 'review', params: { sid: props.sid } });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<template>
  <section class="processing">
    <h1>Processing</h1>
    <p class="muted">Preparing {{ total }} subtitle lines for review.</p>

    <div class="bar">
      <div class="bar__fill" :style="{ width: overallPct + '%' }"></div>
    </div>
    <div class="stage">{{ phaseLabel }}</div>
    <p v-if="alignStats" class="hint">
      Re-aligned {{ alignStats.aligned }} cues; {{ alignStats.skipped }} kept their original
      timing (no confident Whisper match).
    </p>

    <p v-if="error" class="err">{{ error }}</p>
  </section>
</template>

<style scoped>
.processing {
  max-width: 720px;
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
  margin: 0 0 24px;
}
.bar {
  height: 6px;
  background: var(--pageLine);
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 14px;
}
.bar__fill {
  height: 100%;
  background: var(--accent);
  transition: width 200ms ease;
}
.stage {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.err {
  color: #c83a3a;
  font-size: 13px;
  margin-top: 16px;
}
.hint {
  font-size: 12px;
  color: var(--pageMuted);
  margin-top: 10px;
}
</style>
