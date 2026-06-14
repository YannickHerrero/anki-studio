<script setup lang="ts">
import { ref } from 'vue';
import { useSettingsStore, MODEL_PRESETS } from '../stores/settings';

const settings = useSettingsStore();
const showOpenrouter = ref(false);
const showOpenai = ref(false);
const testingOpenrouter = ref(false);
const testingOpenai = ref(false);
const openrouterResult = ref<{ ok: boolean; message: string } | null>(null);
const openaiResult = ref<{ ok: boolean; message: string } | null>(null);

async function testOpenrouter() {
  testingOpenrouter.value = true;
  openrouterResult.value = null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${settings.openrouterKey.trim()}` },
    });
    if (!res.ok) {
      openrouterResult.value = { ok: false, message: `HTTP ${res.status}` };
    } else {
      const json = await res.json();
      openrouterResult.value = {
        ok: true,
        message: `OK — label: ${json.data?.label ?? 'unknown'}`,
      };
    }
  } catch (err) {
    openrouterResult.value = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    testingOpenrouter.value = false;
  }
}

async function testOpenai() {
  testingOpenai.value = true;
  openaiResult.value = null;
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${settings.openaiKey.trim()}` },
    });
    if (!res.ok) {
      openaiResult.value = { ok: false, message: `HTTP ${res.status}` };
    } else {
      openaiResult.value = { ok: true, message: 'OK' };
    }
  } catch (err) {
    openaiResult.value = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    testingOpenai.value = false;
  }
}
</script>

<template>
  <section class="settings">
    <h1>Settings</h1>
    <p class="settings__intro">
      Keys are stored only in your browser's <code>localStorage</code>. The OpenRouter key powers
      enrichment (translation, vocabulary, grammar). The OpenAI key is only used by the YouTube
      flow to transcribe audio with Whisper.
    </p>

    <label class="field">
      <span class="field__label">OpenRouter API key</span>
      <div class="field__row">
        <input
          v-model="settings.openrouterKey"
          :type="showOpenrouter ? 'text' : 'password'"
          placeholder="sk-or-v1-..."
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="ghost" @click="showOpenrouter = !showOpenrouter">
          {{ showOpenrouter ? 'Hide' : 'Show' }}
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
        :disabled="!settings.isConfigured || testingOpenrouter"
        @click="testOpenrouter"
      >
        {{ testingOpenrouter ? 'Testing…' : 'Test OpenRouter key' }}
      </button>
      <span
        v-if="openrouterResult"
        class="result"
        :class="{ 'result--ok': openrouterResult.ok, 'result--err': !openrouterResult.ok }"
      >
        {{ openrouterResult.message }}
      </span>
    </div>

    <hr class="sep" />

    <label class="field">
      <span class="field__label">OpenAI API key — for YouTube transcription only</span>
      <div class="field__row">
        <input
          v-model="settings.openaiKey"
          :type="showOpenai ? 'text' : 'password'"
          placeholder="sk-..."
          autocomplete="off"
          spellcheck="false"
        />
        <button type="button" class="ghost" @click="showOpenai = !showOpenai">
          {{ showOpenai ? 'Hide' : 'Show' }}
        </button>
      </div>
    </label>

    <div class="actions">
      <button
        type="button"
        class="primary"
        :disabled="!settings.openaiKey || testingOpenai"
        @click="testOpenai"
      >
        {{ testingOpenai ? 'Testing…' : 'Test OpenAI key' }}
      </button>
      <span
        v-if="openaiResult"
        class="result"
        :class="{ 'result--ok': openaiResult.ok, 'result--err': !openaiResult.ok }"
      >
        {{ openaiResult.message }}
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
.sep {
  border: none;
  border-top: 1px solid var(--pageLine);
  margin: 30px 0 24px;
}
code {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  background: var(--bPanel);
  padding: 1px 5px;
  border-radius: 3px;
}
</style>
