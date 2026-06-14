<script setup lang="ts">
import { ref } from 'vue';
import { useSettingsStore, MODEL_PRESETS } from '../stores/settings';

const settings = useSettingsStore();
const showKey = ref(false);
const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

async function testKey() {
  testing.value = true;
  testResult.value = null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${settings.openrouterKey.trim()}` },
    });
    if (!res.ok) {
      testResult.value = { ok: false, message: `HTTP ${res.status}` };
    } else {
      const json = await res.json();
      testResult.value = { ok: true, message: `OK — label: ${json.data?.label ?? 'unknown'}` };
    }
  } catch (err) {
    testResult.value = { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <section class="settings">
    <h1>Settings</h1>
    <p class="settings__intro">
      Anki Studio uses your OpenRouter API key to generate translation, vocabulary and grammar
      notes for the cards you keep. The key stays in your browser.
    </p>

    <label class="field">
      <span class="field__label">OpenRouter API key</span>
      <div class="field__row">
        <input
          v-model="settings.openrouterKey"
          :type="showKey ? 'text' : 'password'"
          placeholder="sk-or-v1-..."
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="ghost" @click="showKey = !showKey">
          {{ showKey ? 'Hide' : 'Show' }}
        </button>
      </div>
    </label>

    <label class="field">
      <span class="field__label">Model</span>
      <select v-model="settings.model">
        <option v-for="m in MODEL_PRESETS" :key="m.id" :value="m.id">{{ m.label }}</option>
        <option :value="settings.model" v-if="!MODEL_PRESETS.find((m) => m.id === settings.model)">
          {{ settings.model }} (custom)
        </option>
      </select>
      <input
        type="text"
        class="field__custom"
        placeholder="Or type any OpenRouter model id"
        :value="settings.model"
        @change="(e) => (settings.model = (e.target as HTMLInputElement).value)"
      />
    </label>

    <div class="actions">
      <button
        type="button"
        class="primary"
        :disabled="!settings.isConfigured || testing"
        @click="testKey"
      >
        {{ testing ? 'Testing…' : 'Test key' }}
      </button>
      <span
        v-if="testResult"
        class="result"
        :class="{ 'result--ok': testResult.ok, 'result--err': !testResult.ok }"
      >
        {{ testResult.message }}
      </span>
    </div>
  </section>
</template>

<style scoped>
.settings {
  max-width: 540px;
}
.settings__intro {
  color: var(--pageMuted);
  font-size: 14px;
  line-height: 1.6;
  margin-bottom: 28px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 24px;
  margin: 0 0 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
}
.field__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.field__row {
  display: flex;
  gap: 8px;
}
.field__row input {
  flex: 1;
}
input,
select {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  padding: 10px 12px;
  color: var(--pageInk);
  font-size: 14px;
  font-family: inherit;
}
.field__custom {
  margin-top: 4px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
button {
  border: 1px solid var(--pageLine);
  background: var(--bBg);
  color: var(--pageInk);
  padding: 9px 16px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
}
button.ghost {
  background: transparent;
}
button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.result {
  font-size: 13px;
}
.result--ok {
  color: var(--accent);
}
.result--err {
  color: #c83a3a;
}
</style>
