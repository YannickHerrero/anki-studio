<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter, RouterLink } from 'vue-router';
import { upload } from '../api';
import { useSessionStore } from '../stores/session';
import { useSettingsStore } from '../stores/settings';

const router = useRouter();
const session = useSessionStore();
const settings = useSettingsStore();

const video = ref<File | null>(null);
const subtitle = ref<File | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);

const subtitleExtOk = computed(() => {
  if (!subtitle.value) return true;
  return /\.(srt|ass|ssa|vtt)$/i.test(subtitle.value.name);
});

const canSubmit = computed(
  () => video.value && subtitle.value && subtitleExtOk.value && settings.isConfigured,
);

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

async function submit() {
  if (!video.value || !subtitle.value) return;
  busy.value = true;
  error.value = null;
  try {
    const { sessionId, cueCount } = await upload(video.value, subtitle.value);
    session.sessionId = sessionId;
    session.cueCount = cueCount;
    router.push({ name: 'processing', params: { sid: sessionId } });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
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

    <div
      class="drop"
      @dragover.prevent
      @drop="onDrop"
    >
      <p>Drop a video and a subtitle file here, or use the buttons below.</p>
      <div class="drop__files">
        <div class="drop__file">
          <strong>Video</strong>
          <input type="file" accept="video/*,.mkv,.mp4,.avi,.mov" @change="pickVideo" />
          <div v-if="video" class="meta">
            {{ video.name }} <span class="muted">— {{ formatBytes(video.size) }}</span>
          </div>
        </div>
        <div class="drop__file">
          <strong>Subtitle</strong>
          <input type="file" accept=".srt,.ass,.ssa,.vtt" @change="pickSubtitle" />
          <div v-if="subtitle" class="meta">
            {{ subtitle.name }}
            <span class="muted">— {{ formatBytes(subtitle.size) }}</span>
          </div>
          <div v-if="!subtitleExtOk" class="err">Unsupported subtitle extension.</div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="primary" :disabled="!canSubmit || busy" @click="submit">
        {{ busy ? 'Uploading…' : 'Process' }}
      </button>
      <span v-if="error" class="err">{{ error }}</span>
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
</style>
