import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { CardSummary, PickSummary } from '../api';

export const useSessionStore = defineStore('session', () => {
  const sessionId = ref<string | null>(null);
  const cards = ref<CardSummary[]>([]); // really cues — kept the name for compat with the UI
  const picks = ref<PickSummary[]>([]);
  const cueCount = ref(0);

  const pileCount = computed(() => picks.value.length);
  const alreadyExportedCount = computed(() => picks.value.filter((p) => p.exported).length);
  const pendingExportCount = computed(() => pileCount.value - alreadyExportedCount.value);

  const pickIdsByCue = computed(() => {
    const m = new Map<number, string[]>();
    for (const p of picks.value) {
      const list = m.get(p.cueIndex);
      if (list) list.push(p.id);
      else m.set(p.cueIndex, [p.id]);
    }
    return m;
  });

  function pickCountForCue(cueIndex: number): number {
    return pickIdsByCue.value.get(cueIndex)?.length ?? 0;
  }

  function reset() {
    sessionId.value = null;
    cards.value = [];
    picks.value = [];
    cueCount.value = 0;
  }

  return {
    sessionId,
    cards,
    picks,
    cueCount,
    pileCount,
    alreadyExportedCount,
    pendingExportCount,
    pickIdsByCue,
    pickCountForCue,
    reset,
  };
});
