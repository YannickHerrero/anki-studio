import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';

const STORAGE_KEY = 'anki-studio:settings:v1';

export const MODEL_PRESETS = [
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
] as const;

type Stored = {
  openrouterKey?: string;
  model?: string;
};

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Stored;
  } catch {
    return {};
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const initial = load();
  const openrouterKey = ref(initial.openrouterKey ?? '');
  const model = ref(initial.model ?? MODEL_PRESETS[0].id);

  const isConfigured = computed(() => openrouterKey.value.trim().length > 0);

  watch(
    [openrouterKey, model],
    ([key, m]) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ openrouterKey: key, model: m }));
    },
    { deep: true },
  );

  return { openrouterKey, model, isConfigured };
});
