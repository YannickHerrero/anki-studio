<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { fetchCards, streamSse, saveDecisions } from '../api';
import { useSessionStore } from '../stores/session';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{ sid: string }>();
const session = useSessionStore();
const settings = useSettingsStore();

const deckName = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const enrichedDone = ref(0);
const enrichedTotal = ref(0);
const stage = ref<'idle' | 'enrich' | 'package' | 'ready'>('idle');
const downloadUrl = ref<string | null>(null);
const downloadName = ref<string | null>(null);
const includeExported = ref(false);

const exportTargetCount = computed(() =>
  includeExported.value ? session.keptCount : session.pendingExportCount,
);

const canExport = computed(
  () =>
    settings.isConfigured && exportTargetCount.value > 0 && deckName.value.trim().length > 0,
);

const pct = computed(() =>
  enrichedTotal.value ? Math.round((enrichedDone.value / enrichedTotal.value) * 100) : 0,
);

onMounted(async () => {
  if (!deckName.value) deckName.value = `Anki Studio — ${new Date().toISOString().slice(0, 10)}`;
  // Refresh cards so we see the latest exported flags if the user is coming
  // back to a previously-exported session.
  try {
    const data = await fetchCards(props.sid);
    session.cards = data.cards;
    session.decisions = { ...data.decisions };
  } catch {
    // non-fatal — if the user reloaded right after upload, decisions will catch up
  }
});

async function exportDeck() {
  if (!canExport.value) return;
  busy.value = true;
  error.value = null;
  enrichedDone.value = 0;
  enrichedTotal.value = 0;
  stage.value = 'idle';
  downloadUrl.value = null;
  downloadName.value = null;

  // Persist decisions one last time.
  await saveDecisions(props.sid, session.decisions);

  let succeeded = false;
  try {
    await streamSse(
      `/session/${props.sid}/export`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deckName: deckName.value.trim(),
          openrouterKey: settings.openrouterKey.trim(),
          model: settings.model,
          includeExported: includeExported.value,
        }),
      },
      ({ event, data }) => {
        const d = data as {
          total?: number;
          done?: number;
          message?: string;
          downloadUrl?: string;
          filename?: string;
          stage?: string;
        };
        if (event === 'start') {
          enrichedTotal.value = d.total ?? 0;
          stage.value = 'enrich';
        } else if (event === 'progress') {
          enrichedDone.value = d.done ?? 0;
        } else if (event === 'build') {
          stage.value = 'package';
        } else if (event === 'ready') {
          stage.value = 'ready';
          succeeded = true;
          downloadUrl.value = d.downloadUrl ?? null;
          downloadName.value = d.filename ?? 'deck.apkg';
        } else if (event === 'error') {
          error.value = d.message ?? 'export failed';
        }
      },
    );
    // Refresh local card state so exported flags update without a reload.
    if (succeeded) {
      const data = await fetchCards(props.sid);
      session.cards = data.cards;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="export">
    <h1>Export</h1>
    <p class="muted">
      Kept {{ session.keptCount }} of {{ session.cards.length }} cards.
      <span v-if="session.alreadyExportedCount > 0">
        {{ session.alreadyExportedCount }} are already in a previous .apkg,
        {{ session.pendingExportCount }} are new.
      </span>
      Each card included will be enriched with vocabulary and grammar via OpenRouter, then bundled
      as a single .apkg.
    </p>

    <p v-if="!settings.isConfigured" class="warn">
      Set an OpenRouter API key in <RouterLink to="/settings">Settings</RouterLink> first.
    </p>

    <label class="field">
      <span class="field__label">Deck name</span>
      <input v-model="deckName" type="text" placeholder="My Anime Deck" />
    </label>

    <label v-if="session.alreadyExportedCount > 0" class="checkbox">
      <input type="checkbox" v-model="includeExported" />
      Also include the {{ session.alreadyExportedCount }} cards from previous exports
      <span class="muted small">(re-enriches them and produces a single full deck)</span>
    </label>

    <div class="actions">
      <button class="primary" :disabled="!canExport || busy" @click="exportDeck">
        {{
          busy
            ? 'Working…'
            : exportTargetCount === 0
              ? 'No cards to export'
              : `Generate & download .apkg (${exportTargetCount} cards)`
        }}
      </button>
      <RouterLink :to="{ name: 'review', params: { sid } }" class="ghost">Back to review</RouterLink>
    </div>

    <div v-if="busy || stage !== 'idle'" class="progress">
      <div class="bar">
        <div class="bar__fill" :style="{ width: pct + '%' }"></div>
      </div>
      <div class="stage">
        <span v-if="stage === 'enrich'">Enriching {{ enrichedDone }} / {{ enrichedTotal }}</span>
        <span v-else-if="stage === 'package'">Packaging .apkg…</span>
        <span v-else-if="stage === 'ready'">Done.</span>
      </div>
    </div>

    <div v-if="stage === 'ready' && downloadUrl" class="download">
      <a class="primary" :href="`/api${downloadUrl}`" :download="downloadName ?? 'deck.apkg'">
        Download {{ downloadName }}
      </a>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </section>
</template>

<style scoped>
.export {
  max-width: 640px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 24px;
  margin: 0 0 12px;
}
.muted {
  color: var(--pageMuted);
  font-size: 14px;
  line-height: 1.6;
  margin: 0 0 22px;
}
.warn {
  background: var(--bPanel);
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  padding: 12px 14px;
  font-size: 13px;
  margin-bottom: 18px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 18px;
}
.field__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
input {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  padding: 10px 12px;
  font-size: 14px;
  color: var(--pageInk);
  font-family: inherit;
}
.actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
}
.primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: white;
  padding: 10px 22px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  text-decoration: none;
  letter-spacing: 0.04em;
  display: inline-flex;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ghost {
  font-size: 13px;
  color: var(--pageMuted);
}
.progress {
  margin-bottom: 18px;
}
.bar {
  height: 6px;
  background: var(--pageLine);
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 10px;
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
.download {
  margin-top: 12px;
}
.err {
  color: #c83a3a;
  font-size: 13px;
  margin-top: 16px;
}
.checkbox {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  margin-bottom: 22px;
  color: var(--pageInk);
}
.checkbox input {
  width: auto;
}
.small {
  font-size: 12px;
}
</style>
