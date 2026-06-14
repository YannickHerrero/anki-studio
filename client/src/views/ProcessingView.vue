<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { streamSse } from '../api';

const props = defineProps<{ sid: string }>();
const router = useRouter();

const total = ref(0);
const audioDone = ref(0);
const screenshotDone = ref(0);
const error = ref<string | null>(null);
const done = ref(false);

const pct = computed(() => {
  if (!total.value) return 0;
  return Math.round(((audioDone.value + screenshotDone.value) / (2 * total.value)) * 100);
});

onMounted(async () => {
  try {
    await streamSse(
      `/session/${props.sid}/process`,
      { method: 'POST' },
      ({ event, data }) => {
        const d = data as { total?: number; done?: number; kind?: string; message?: string };
        if (event === 'start') {
          total.value = d.total ?? 0;
        } else if (event === 'progress') {
          if (d.kind === 'audio') audioDone.value = d.done ?? 0;
          else if (d.kind === 'screenshot') screenshotDone.value = d.done ?? 0;
        } else if (event === 'done') {
          done.value = true;
          router.replace({ name: 'review', params: { sid: props.sid } });
        } else if (event === 'error') {
          error.value = d.message ?? 'processing failed';
        }
      },
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<template>
  <section class="processing">
    <h1>Processing</h1>
    <p class="muted">Cutting audio clips and screenshots for {{ total }} subtitle lines.</p>

    <div class="bar">
      <div class="bar__fill" :style="{ width: pct + '%' }"></div>
    </div>
    <div class="stats">
      <span>Audio {{ audioDone }} / {{ total }}</span>
      <span>Screenshots {{ screenshotDone }} / {{ total }}</span>
      <span>{{ pct }}%</span>
    </div>

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
.stats {
  display: flex;
  gap: 22px;
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
