<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { fetchCards, fetchPicks, streamSse, freeSpace } from '../api';
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
const videoRemoved = ref(false);
const freeing = ref(false);
const freedMsg = ref<string | null>(null);

const exportTargetCount = computed(() =>
  includeExported.value ? session.pileCount : session.pendingExportCount,
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
    videoRemoved.value = data.videoRemoved;
    const piles = await fetchPicks(props.sid);
    session.picks = piles.picks;
  } catch {
    // non-fatal — pile UI will catch up on next refresh
  }
});

async function doFreeSpace() {
  if (
    !confirm(
      'Delete the source video to free disk space? Your cards stay; retiming or merging ' +
        'later will require re-linking the video.',
    )
  )
    return;
  freeing.value = true;
  try {
    const { freedBytes } = await freeSpace(props.sid);
    videoRemoved.value = true;
    const mb = Math.round(freedBytes / 1_000_000);
    freedMsg.value = mb > 0 ? `Freed ${mb} MB.` : 'Video removed.';
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    freeing.value = false;
  }
}

async function exportDeck() {
  if (!canExport.value) return;
  busy.value = true;
  error.value = null;
  enrichedDone.value = 0;
  enrichedTotal.value = 0;
  stage.value = 'idle';
  downloadUrl.value = null;
  downloadName.value = null;

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
          // Server emits two kinds (word, grammar). Display whichever is currently advancing.
          enrichedDone.value = d.done ?? 0;
          if (typeof d.total === 'number') enrichedTotal.value = d.total;
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
    // Refresh local pile state so the exported flags update without a reload.
    if (succeeded) {
      const piles = await fetchPicks(props.sid);
      session.picks = piles.picks;
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
      Pile: {{ session.pileCount }} picked word{{ session.pileCount === 1 ? '' : 's' }}.
      <span v-if="session.alreadyExportedCount > 0">
        {{ session.alreadyExportedCount }} already in previous .apkgs · {{ session.pendingExportCount }} new.
      </span>
      Every pick becomes one Anki vocab card. Word definitions, grammar and the rest of the back
      are generated via OpenRouter at build time.
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
      Also include the {{ session.alreadyExportedCount }} picks shipped previously
      <span class="muted small">(re-enriches them and produces a single full deck)</span>
    </label>

    <div class="actions">
      <button class="primary" :disabled="!canExport || busy" @click="exportDeck">
        {{
          busy
            ? 'Working…'
            : exportTargetCount === 0
              ? 'Pile is empty'
              : `Generate & download .apkg (${exportTargetCount} card${exportTargetCount === 1 ? '' : 's'})`
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

    <div class="free">
      <button
        v-if="!videoRemoved"
        type="button"
        class="ghost"
        :disabled="freeing"
        @click="doFreeSpace"
      >
        {{ freeing ? 'Freeing…' : 'Free space (delete source video)' }}
      </button>
      <span v-else class="muted small">Source video freed. Re-link it from review to retime/merge.</span>
      <span v-if="freedMsg" class="muted small">· {{ freedMsg }}</span>
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
.free {
  margin-top: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.free .ghost {
  background: transparent;
  border: 1px solid var(--pageLine);
  padding: 8px 14px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--pageInk);
}
.free .ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
