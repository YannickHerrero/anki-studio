<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { streamSse } from '../api';
import { useSettingsStore } from '../stores/settings';
import { useSessionStore } from '../stores/session';

const router = useRouter();
const settings = useSettingsStore();
const session = useSessionStore();

const url = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

type Phase =
  | 'idle'
  | 'download'
  | 'transcribe'
  | 'refine'
  | 'translate'
  | 'process'
  | 'done';
const phase = ref<Phase>('idle');

const downloadPct = ref(0);
const cueCount = ref(0);
const audioStage = ref<'extracting' | 'done' | ''>('');
const videoTitle = ref('');
const processedDone = ref(0);
const processedTotal = ref(0);

const URL_RE = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?[^#]*\bv=[\w-]{11}|shorts\/[\w-]{11})|youtu\.be\/[\w-]{11})/;
const looksLikeYoutube = computed(() => URL_RE.test(url.value.trim()));
const canSubmit = computed(
  () => looksLikeYoutube.value && settings.isYoutubeReady && !busy.value,
);

async function go() {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = null;
  phase.value = 'idle';
  downloadPct.value = 0;
  cueCount.value = 0;
  processedDone.value = 0;
  processedTotal.value = 0;
  audioStage.value = '';
  videoTitle.value = '';

  let sid: string | null = null;

  try {
    // 1. Download + extract audio
    phase.value = 'download';
    await streamSse(
      '/youtube',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.value.trim() }),
      },
      ({ event, data }) => {
        const d = data as {
          sessionId?: string;
          title?: string;
          pct?: number;
          stage?: string;
          message?: string;
        };
        if (event === 'session') sid = d.sessionId ?? null;
        else if (event === 'meta') videoTitle.value = d.title ?? '';
        else if (event === 'download') downloadPct.value = d.pct ?? 0;
        else if (event === 'audio') audioStage.value = (d.stage as 'extracting' | 'done') ?? '';
        else if (event === 'error') throw new Error(d.message ?? 'download failed');
      },
    );
    if (!sid) throw new Error('no session id from /youtube');
    session.sessionId = sid;

    // 2. Transcribe with Whisper
    phase.value = 'transcribe';
    await streamSse(
      `/session/${sid}/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ openaiKey: settings.openaiKey.trim() }),
      },
      ({ event, data }) => {
        const d = data as { cueCount?: number; message?: string };
        if (event === 'done') cueCount.value = d.cueCount ?? 0;
        else if (event === 'error') throw new Error(d.message ?? 'transcription failed');
      },
    );

    // 3. Refine sentence splits with the LLM (uses word timestamps for timing).
    // Best-effort: if it fails, keep the heuristic splits we already have.
    phase.value = 'refine';
    try {
      await streamSse(
        `/session/${sid}/refineSplits`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            openrouterKey: settings.openrouterKey.trim(),
            model: settings.model,
          }),
        },
        ({ event, data }) => {
          const d = data as { cueCount?: number; message?: string };
          if (event === 'done') cueCount.value = d.cueCount ?? cueCount.value;
          else if (event === 'error') throw new Error(d.message ?? 'refine failed');
        },
      );
    } catch (err) {
      // Surface but don't abort the whole flow — heuristic cues are still usable.
      // eslint-disable-next-line no-console
      console.warn('split refinement failed, keeping heuristic cues:', err);
    }

    // 4. Translate whole transcript in one call
    phase.value = 'translate';
    await streamSse(
      `/session/${sid}/translate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          openrouterKey: settings.openrouterKey.trim(),
          model: settings.model,
        }),
      },
      ({ event, data }) => {
        const d = data as { message?: string };
        if (event === 'error') throw new Error(d.message ?? 'translation failed');
      },
    );

    // 5. Cut per-cue audio + screenshots (reuses /process)
    phase.value = 'process';
    processedTotal.value = cueCount.value;
    await streamSse(
      `/session/${sid}/process`,
      { method: 'POST' },
      ({ event, data }) => {
        const d = data as { total?: number; done?: number; kind?: string; message?: string };
        if (event === 'start') processedTotal.value = d.total ?? cueCount.value;
        else if (event === 'progress' && d.kind === 'audio') processedDone.value = d.done ?? 0;
        else if (event === 'error') throw new Error(d.message ?? 'processing failed');
      },
    );

    phase.value = 'done';
    router.replace({ name: 'review', params: { sid } });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

const phaseLabel = computed(() => {
  switch (phase.value) {
    case 'download':
      return `Downloading ${downloadPct.value.toFixed(0)}%` + (audioStage.value === 'extracting' ? ' — extracting audio…' : '');
    case 'transcribe':
      return 'Transcribing with Whisper…';
    case 'refine':
      return 'Refining sentence splits with LLM…';
    case 'translate':
      return 'Translating whole transcript…';
    case 'process':
      return `Cutting clips ${processedDone.value} / ${processedTotal.value}`;
    case 'done':
      return 'Done.';
    default:
      return '';
  }
});

const overallPct = computed(() => {
  // Rough 4-phase progress for the bar.
  switch (phase.value) {
    case 'download':
      return Math.round(downloadPct.value * 0.4);
    case 'transcribe':
      return 45;
    case 'refine':
      return 55;
    case 'translate':
      return 65;
    case 'process':
      return processedTotal.value
        ? 65 + Math.round((processedDone.value / processedTotal.value) * 35)
        : 65;
    case 'done':
      return 100;
    default:
      return 0;
  }
});
</script>

<template>
  <section class="youtube">
    <h1>YouTube</h1>
    <p class="muted">
      Paste a YouTube URL. We'll download a 480p copy, transcribe the Japanese audio with Whisper,
      then translate every sentence using the whole transcript as context. Then you'll review the
      cards like with an uploaded video.
    </p>

    <p v-if="!settings.isYoutubeReady" class="warn">
      You need both an OpenRouter key and an OpenAI key.
      <RouterLink to="/settings">Add them in Settings</RouterLink>.
    </p>

    <label class="field">
      <span class="field__label">YouTube URL</span>
      <input
        v-model="url"
        type="url"
        placeholder="https://www.youtube.com/watch?v=…"
        autocomplete="off"
        spellcheck="false"
        :disabled="busy"
      />
      <span v-if="url && !looksLikeYoutube" class="err">Doesn't look like a YouTube URL.</span>
    </label>

    <div class="actions">
      <button class="primary" :disabled="!canSubmit" @click="go">
        {{ busy ? 'Working…' : 'Process' }}
      </button>
    </div>

    <div v-if="phase !== 'idle'" class="progress">
      <div v-if="videoTitle" class="title">{{ videoTitle }}</div>
      <div class="bar">
        <div class="bar__fill" :style="{ width: overallPct + '%' }"></div>
      </div>
      <div class="stage">{{ phaseLabel }}</div>
    </div>

    <p v-if="error" class="err">{{ error }}</p>
  </section>
</template>

<style scoped>
.youtube {
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
  margin-bottom: 22px;
}
.warn a {
  color: var(--accent);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 22px;
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
  margin-bottom: 22px;
}
.primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: white;
  padding: 10px 22px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  letter-spacing: 0.04em;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.progress {
  margin-top: 4px;
}
.title {
  font-size: 13px;
  color: var(--pageMuted);
  margin-bottom: 8px;
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
.err {
  color: #c83a3a;
  font-size: 13px;
  margin-top: 16px;
}
</style>
