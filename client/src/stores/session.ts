import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { CardSummary, Decision } from '../api';

export const useSessionStore = defineStore('session', () => {
  const sessionId = ref<string | null>(null);
  const cards = ref<CardSummary[]>([]);
  const decisions = ref<Record<number, Decision>>({});
  const cueCount = ref(0);

  const keptCount = computed(
    () => Object.values(decisions.value).filter((d) => d === 'keep').length,
  );
  const skippedCount = computed(
    () => Object.values(decisions.value).filter((d) => d === 'skip').length,
  );
  const remainingCount = computed(() => cards.value.length - keptCount.value - skippedCount.value);

  function reset() {
    sessionId.value = null;
    cards.value = [];
    decisions.value = {};
    cueCount.value = 0;
  }

  return {
    sessionId,
    cards,
    decisions,
    cueCount,
    keptCount,
    skippedCount,
    remainingCount,
    reset,
  };
});
