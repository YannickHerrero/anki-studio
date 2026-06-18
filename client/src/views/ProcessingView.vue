<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { streamSse } from '../api';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{ sid: string }>();
const router = useRouter();
const settings = useSettingsStore();

type Phase = 'idle' | 'cut' | 'translate' | 'done';
const phase = ref<Phase>('idle');

const total = ref(0);
const audioDone = ref(0);
const screenshotDone = ref(0);
const error = ref<string | null>(null);

const cutPct = computed(() => {
  if (!total.value) return 0;
  return Math.round(((audioDone.value + screenshotDone.value) / (2 * total.value)) * 100);
});

const overallPct = computed(() => {
  switch (phase.value) {
    case 'cut':
      return Math.round(cutPct.value * 0.85);
    case 'translate':
      return 90;
    case 'done':
      return 100;
    default:
      return 0;
  }
});

const phaseLabel = computed(() => {
  switch (phase.value) {
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

onMounted(async () => {
  try {
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
