<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ values: number[]; width?: number; height?: number }>(),
  { width: 220, height: 56 },
);

const W = props.width;
const H = props.height;
const PAD = 4;

// Map values onto the viewBox. A flat/empty series sits on the baseline.
const points = computed(() => {
  const vs = props.values;
  if (vs.length === 0) return [] as Array<{ x: number; y: number }>;
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const stepX = vs.length > 1 ? (W - PAD * 2) / (vs.length - 1) : 0;
  return vs.map((v, i) => ({
    x: PAD + i * stepX,
    y: H - PAD - ((v - min) / span) * (H - PAD * 2),
  }));
});

const line = computed(() => points.value.map((p) => `${p.x},${p.y}`).join(' '));
const area = computed(() => {
  if (points.value.length < 2) return '';
  const first = points.value[0]!;
  const last = points.value[points.value.length - 1]!;
  return `${first.x},${H - PAD} ${line.value} ${last.x},${H - PAD}`;
});
const last = computed(() => points.value[points.value.length - 1] ?? null);
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="spark" preserveAspectRatio="none">
    <defs>
      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28" />
        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
      </linearGradient>
    </defs>
    <polygon v-if="area" :points="area" fill="url(#sparkFill)" />
    <polyline
      v-if="points.length > 1"
      :points="line"
      fill="none"
      stroke="var(--accent)"
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
    <circle v-if="last" :cx="last.x" :cy="last.y" r="3" fill="var(--accent)" />
  </svg>
</template>

<style scoped>
.spark {
  width: 100%;
  height: 56px;
  display: block;
}
</style>
