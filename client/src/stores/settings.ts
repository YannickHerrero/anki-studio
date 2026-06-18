import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';

const STORAGE_KEY = 'anki-studio:settings:v1';

export const MODEL_PRESETS = [
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
] as const;

type Stored = {
  openrouterKey?: string;
  openaiKey?: string;
  model?: string;
  ankiConnectUrl?: string;
  knownDecks?: string[];
  wordField?: string;
  knownThresholdDays?: number;
};

export const DEFAULT_ANKICONNECT_URL = 'http://127.0.0.1:8765';

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
  const openaiKey = ref(initial.openaiKey ?? '');
  const model = ref(initial.model ?? MODEL_PRESETS[0].id);
  const ankiConnectUrl = ref(initial.ankiConnectUrl ?? DEFAULT_ANKICONNECT_URL);
  const knownDecks = ref<string[]>(initial.knownDecks ?? []);
  const wordField = ref(initial.wordField ?? '');
  const knownThresholdDays = ref(initial.knownThresholdDays ?? 10);

  const isConfigured = computed(() => openrouterKey.value.trim().length > 0);
  const isYoutubeReady = computed(
    () => openrouterKey.value.trim().length > 0 && openaiKey.value.trim().length > 0,
  );

  watch(
    [openrouterKey, openaiKey, model, ankiConnectUrl, knownDecks, wordField, knownThresholdDays],
    () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          openrouterKey: openrouterKey.value,
          openaiKey: openaiKey.value,
          model: model.value,
          ankiConnectUrl: ankiConnectUrl.value,
          knownDecks: knownDecks.value,
          wordField: wordField.value,
          knownThresholdDays: knownThresholdDays.value,
        }),
      );
    },
    { deep: true },
  );

  return {
    openrouterKey,
    openaiKey,
    model,
    ankiConnectUrl,
    knownDecks,
    wordField,
    knownThresholdDays,
    isConfigured,
    isYoutubeReady,
  };
});
