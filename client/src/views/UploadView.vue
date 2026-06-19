<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { upload, setAudioTrack, type AudioStream } from '../api';
import { useSessionStore } from '../stores/session';
import { useSettingsStore } from '../stores/settings';

const router = useRouter();
const session = useSessionStore();
const settings = useSettingsStore();

const video = ref<File | null>(null);
const subtitle = ref<File | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const alignSubtitles = ref(false);

const pendingSessionId = ref<string | null>(null);
const audioStreams = ref<AudioStream[]>([]);
const chosenTrack = ref<number | null>(null);
const savingTrack = ref(false);

const subtitleExtOk = computed(() => {
  if (!subtitle.value) return true;
  return /\.(srt|ass|ssa|vtt)$/i.test(subtitle.value.name);
});

const willTranscribe = computed(() => !subtitle.value);

const canAlign = computed(() => !!subtitle.value && !!settings.openaiKey.trim());

const canSubmit = computed(() => {
  if (!video.value || !subtitleExtOk.value || !settings.isConfigured) return false;
  // Without a subtitle file we'll transcribe with Whisper, which requires the
  // OpenAI key from Settings.
  if (willTranscribe.value && !settings.openaiKey.trim()) return false;
  // If the user asked to align, they need the OpenAI key.
  if (alignSubtitles.value && !settings.openaiKey.trim()) return false;
  return true;
});

function pickVideo(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) video.value = f;
}
function pickSubtitle(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) subtitle.value = f;
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    if (/\.(srt|ass|ssa|vtt)$/i.test(f.name)) subtitle.value = f;
    else video.value = f;
  }
}

const splitInfo = ref<{ total: number; durationMs: number } | null>(null);

async function submit() {
  if (!canSubmit.value || !video.value) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await upload(video.value, subtitle.value);
    session.sessionId = result.sessionId;
    session.cueCount = result.cueCount;

    // Long video → server fanned out into N sibling sessions. Land on the
    // Sessions list so the user can pick which chunk to process first.
    if (result.split && (result.totalChunks ?? 1) > 1) {
      splitInfo.value = {
        total: result.totalChunks ?? 1,
        durationMs: result.durationMs ?? 0,
      };
      // Brief pause so the user sees the feedback, then redirect.
      setTimeout(() => {
        router.push({ name: 'sessions' });
      }, 1600);
      return;
    }

    // Multi-track file with no clear Japanese — ask the user before continuing.
    if (result.audioStreams.length > 1 && result.audioTrackIndex === null) {
      pendingSessionId.value = result.sessionId;
      audioStreams.value = result.audioStreams;
      chosenTrack.value = result.audioStreams[0]?.index ?? 0;
      return;
    }

    router.push({
      name: 'processing',
      params: { sid: result.sessionId },
      query: alignSubtitles.value && subtitle.value ? { align: '1' } : undefined,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function describeTrack(t: AudioStream): string {
  const lang = t.language ? t.language.toUpperCase() : '—';
  const title = t.title ? ` · ${t.title}` : '';
  const def = t.isDefault ? ' (default)' : '';
  return `${lang}${title}${def} · ${t.codec} ${t.channels}ch`;
}

async function confirmTrack() {
  if (pendingSessionId.value === null || chosenTrack.value === null) return;
  savingTrack.value = true;
  error.value = null;
  try {
    await setAudioTrack(pendingSessionId.value, chosenTrack.value);
    const sid = pendingSessionId.value;
    const align = alignSubtitles.value && subtitle.value ? { align: '1' } : undefined;
    pendingSessionId.value = null;
    router.push({ name: 'processing', params: { sid }, query: align });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingTrack.value = false;
  }
}

function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}
</script>

<template>
  <section class="upload">
    <h1>Upload</h1>
    <p v-if="!settings.isConfigured" class="warn">
      No OpenRouter key configured.
      <RouterLink to="/settings">Add one in Settings</RouterLink> before processing —
      enrichment runs during export.
    </p>
    <p v-else-if="willTranscribe && !settings.openaiKey.trim()" class="warn">
      No subtitle file given — Whisper will transcribe the audio, which needs an
      <RouterLink to="/settings">OpenAI API key</RouterLink>.
    </p>
    <p v-else-if="willTranscribe" class="hint">
      No subtitle file given — we'll transcribe with Whisper after upload.
    </p>

    <div
      class="drop"
      @dragover.prevent
      @drop="onDrop"
    >
      <p>
        Drop a video here, plus a subtitle file if you have one. Without subtitles we'll
        transcribe with Whisper.
      </p>
      <div class="drop__files">
        <div class="drop__file">
          <strong>Video</strong>
          <input type="file" accept="video/*,.mkv,.mp4,.avi,.mov" @change="pickVideo" />
          <div v-if="video" class="meta">
            {{ video.name }} <span class="muted">— {{ formatBytes(video.size) }}</span>
          </div>
        </div>
        <div class="drop__file">
          <strong>Subtitle <span class="muted">(optional)</span></strong>
          <input type="file" accept=".srt,.ass,.ssa,.vtt" @change="pickSubtitle" />
          <div v-if="subtitle" class="meta">
            {{ subtitle.name }}
            <span class="muted">— {{ formatBytes(subtitle.size) }}</span>
          </div>
          <div v-else class="muted small">none — will transcribe with Whisper</div>
          <div v-if="!subtitleExtOk" class="err">Unsupported subtitle extension.</div>
          <label v-if="subtitle" class="align-toggle">
            <input
              type="checkbox"
              v-model="alignSubtitles"
              :disabled="!settings.openaiKey.trim()"
            />
            <span>
              Use Whisper to re-time these subtitles
              <span v-if="!settings.openaiKey.trim()" class="muted small">
                — needs an OpenAI key
              </span>
            </span>
          </label>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="primary" :disabled="!canSubmit || busy || !!pendingSessionId" @click="submit">
        {{ busy ? 'Uploading…' : 'Process' }}
      </button>
      <span v-if="error" class="err">{{ error }}</span>
    </div>

    <div v-if="splitInfo" class="split-banner">
      <strong>Split into {{ splitInfo.total }} sessions</strong>
      <span class="muted small">
        — {{ formatDuration(splitInfo.durationMs) }} video, ~25 min per chunk.
        Redirecting to your sessions list…
      </span>
    </div>

    <div v-if="pendingSessionId" class="track-picker">
      <h2>Pick the Japanese audio track</h2>
      <p class="muted small">
        This file has {{ audioStreams.length }} audio tracks and none is unambiguously tagged
        Japanese. Choose the one to use for clips and transcription.
      </p>
      <ul class="tracks">
        <li v-for="t in audioStreams" :key="t.index" class="tracks__item">
          <label>
            <input type="radio" :value="t.index" v-model="chosenTrack" />
            <span class="tracks__num">#{{ t.index }}</span>
            <span class="tracks__desc">{{ describeTrack(t) }}</span>
          </label>
        </li>
      </ul>
      <div class="actions">
        <button
          class="primary"
          :disabled="chosenTrack === null || savingTrack"
          @click="confirmTrack"
        >
          {{ savingTrack ? 'Saving…' : 'Use this track' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.upload {
  max-width: 720px;
}
h1 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 24px;
  margin: 0 0 18px;
}
.warn {
  background: var(--bPanel);
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  padding: 12px 14px;
  font-size: 13px;
  color: var(--pageInk);
  margin-bottom: 22px;
}
.warn a {
  color: var(--accent);
}
.hint {
  font-size: 12px;
  color: var(--pageMuted);
  margin: 0 0 18px;
}
.small {
  font-size: 11px;
}
.drop {
  border: 1.5px dashed var(--pageLine);
  border-radius: 8px;
  padding: 28px;
  margin-bottom: 24px;
}
.drop p {
  margin: 0 0 18px;
  color: var(--pageMuted);
  font-size: 14px;
}
.drop__files {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.drop__file {
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drop__file strong {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.meta {
  font-size: 13px;
}
.muted {
  color: var(--pageMuted);
}
.err {
  color: #c83a3a;
  font-size: 13px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
button.primary {
  background: var(--accent);
  border: 1px solid var(--accent);
  color: white;
  padding: 10px 22px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  letter-spacing: 0.04em;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.track-picker {
  margin-top: 22px;
  padding: 18px 20px;
  border: 1px solid var(--pageLine);
  border-radius: 6px;
  background: var(--bBg);
}
.track-picker h2 {
  font-family: 'Shippori Mincho', serif;
  font-weight: 600;
  font-size: 16px;
  margin: 0 0 6px;
}
.track-picker .small {
  font-size: 12px;
  margin-bottom: 14px;
}
.tracks {
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tracks__item label {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  cursor: pointer;
  font-size: 13px;
  color: var(--pageInk);
}
.tracks__num {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--pageMuted);
  width: 30px;
}
.tracks__desc {
  flex: 1;
}
.split-banner {
  margin-top: 20px;
  padding: 12px 16px;
  background: var(--accentSoft);
  border: 1px solid var(--accent);
  border-radius: 6px;
  color: var(--pageInk);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
}
.split-banner strong {
  color: var(--accent);
}
.align-toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--pageInk);
  margin-top: 4px;
  cursor: pointer;
}
.align-toggle input {
  margin-top: 2px;
}
</style>
