<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { streamSse } from '../api';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{ sid: string }>();
const router = useRouter();
const settings = useSettingsStore();

type Phase = 'idle' | 'transcribe' | 'refine' | 'cut' | 'translate' | 'done';
const phase = ref<Phase>('idle');

const total = ref(0);
const audioDone = ref(0);
const screenshotDone = ref(0);
const error = ref<string | null>(null);
const audioExtractStage = ref<'extracting' | 'done' | ''>('');

const cutPct = computed(() => {
  if (!total.value) return 0;
  return Math.round(((audioDone.value + screenshotDone.value) / (2 * total.value)) * 100);
});

const overallPct = computed(() => {
  switch (phase.value) {
    case 'transcribe':
      return 25;
    case 'refine':
      return 40;
    case 'cut':
      return 50 + Math.round(cutPct.value * 0.4);
    case 'translate':
      return 92;
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
    case 'cut':
      return `Cutting clips — audio ${audioDone.value}/${total.value}, screenshots ${screenshotDone.value}/${total.value}`;
    case 'translate':
      return 'Translating subtitles in whole-transcript context…';
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

onMounted(async () => {
  try {
    // 0. If the session has no cues yet (no subtitle was uploaded), transcribe.
    await ensureTranscript();

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
</style>
