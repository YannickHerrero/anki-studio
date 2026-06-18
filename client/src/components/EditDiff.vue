<script setup lang="ts">
import { computed } from 'vue';
import { diffChars } from '../diff';
import type { EditProposal } from '../api';

const props = defineProps<{
  proposal: EditProposal;
  current: { text?: string; translation?: string; note?: string };
  applied?: boolean;
}>();

const emit = defineEmits<{ apply: []; reject: [] }>();

const FIELD_LABELS: Record<string, string> = {
  text: 'Japanese',
  translation: 'Translation',
  note: 'Note',
};

const change = computed(() => {
  const field = (['text', 'translation', 'note'] as const).find(
    (f) => props.proposal[f] !== undefined,
  );
  if (!field) return null;
  const before = props.current[field] ?? '';
  const after = props.proposal[field] ?? '';
  return { field, label: FIELD_LABELS[field], segments: diffChars(before, after) };
});
</script>

<template>
  <div v-if="change" class="proposal">
    <div class="proposal__label">Proposed {{ change.label }}</div>
    <p class="proposal__diff">
      <template v-for="(seg, i) in change.segments" :key="i">
        <del v-if="seg.removed" class="seg seg--removed">{{ seg.value }}</del>
        <ins v-else-if="seg.added" class="seg seg--added">{{ seg.value }}</ins>
        <span v-else>{{ seg.value }}</span>
      </template>
    </p>
    <div v-if="applied" class="proposal__applied">Applied ✓</div>
    <div v-else class="proposal__actions">
      <button class="apply" @click="emit('apply')">Apply</button>
      <button class="reject" @click="emit('reject')">Reject</button>
    </div>
  </div>
</template>

<style scoped>
.proposal {
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 10px 12px;
  background: var(--bPanel);
  margin-top: 6px;
}
.proposal__label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--pageMuted);
  margin-bottom: 6px;
}
.proposal__diff {
  margin: 0 0 10px;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.seg {
  text-decoration: none;
  border-radius: 2px;
  padding: 0 1px;
}
.seg--added {
  background: rgba(63, 125, 95, 0.22);
  color: var(--pageInk);
}
.seg--removed {
  background: rgba(200, 58, 58, 0.18);
  color: #c83a3a;
  text-decoration: line-through;
}
.proposal__actions {
  display: flex;
  gap: 8px;
}
.apply,
.reject {
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
}
.apply {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}
.reject {
  background: transparent;
  color: var(--pageInk);
}
.proposal__applied {
  font-size: 12px;
  color: var(--accent);
  letter-spacing: 0.08em;
}
</style>
