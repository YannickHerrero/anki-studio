<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { streamChat, type ChatMessage, type EditProposal } from '../api';
import { useSettingsStore } from '../stores/settings';
import EditDiff from './EditDiff.vue';

const props = defineProps<{
  sid: string;
  card: { index: number; text: string; translation?: string; note?: string };
}>();

const emit = defineEmits<{ apply: [edit: EditProposal] }>();

const settings = useSettingsStore();

type Proposal = { tool: string; edit: EditProposal; applied: boolean };
type Turn = { role: 'user' | 'assistant'; content: string; proposals: Proposal[] };

const turns = ref<Turn[]>([]);
const input = ref('');
const streaming = ref(false);
const error = ref<string | null>(null);
const scroller = ref<HTMLElement | null>(null);

// Chat is ephemeral — reset whenever we move to a different line.
watch(
  () => props.card.index,
  () => {
    turns.value = [];
    input.value = '';
    error.value = null;
  },
);

async function scrollToBottom() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}

function history(): ChatMessage[] {
  return turns.value.map((t) => ({ role: t.role, content: t.content }));
}

async function send() {
  const text = input.value.trim();
  if (!text || streaming.value) return;
  if (!settings.openrouterKey) {
    error.value = 'Set your OpenRouter key in Settings first.';
    return;
  }
  error.value = null;
  input.value = '';

  turns.value.push({ role: 'user', content: text, proposals: [] });
  const assistant: Turn = { role: 'assistant', content: '', proposals: [] };
  turns.value.push(assistant);
  streaming.value = true;
  void scrollToBottom();

  try {
    await streamChat(
      props.sid,
      {
        index: props.card.index,
        messages: history().slice(0, -1),
        openrouterKey: settings.openrouterKey,
        model: settings.model,
      },
      ({ event, data }) => {
        if (event === 'token') {
          assistant.content += (data as { text?: string }).text ?? '';
          void scrollToBottom();
        } else if (event === 'proposal') {
          const d = data as { tool?: string; edit?: EditProposal };
          if (d.edit) {
            assistant.proposals.push({ tool: d.tool ?? '', edit: d.edit, applied: false });
            void scrollToBottom();
          }
        } else if (event === 'error') {
          error.value = (data as { message?: string }).message ?? 'chat failed';
        }
      },
    );
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    streaming.value = false;
  }
}

function apply(p: Proposal) {
  p.applied = true;
  emit('apply', p.edit);
}
</script>

<template>
  <aside class="chat">
    <div class="chat__head">
      <span class="chat__title">Discuss this line</span>
    </div>

    <div ref="scroller" class="chat__log">
      <p v-if="!turns.length" class="chat__empty">
        Ask about grammar or a name, or ask to fix the translation, note, or furigana.
      </p>
      <div v-for="(t, i) in turns" :key="i" class="msg" :class="`msg--${t.role}`">
        <div v-if="t.content" class="msg__body">{{ t.content }}</div>
        <div v-else-if="t.role === 'assistant' && streaming && i === turns.length - 1" class="msg__body msg__body--pending">…</div>
        <EditDiff
          v-for="(p, j) in t.proposals"
          :key="j"
          :proposal="p.edit"
          :current="card"
          :applied="p.applied"
          @apply="apply(p)"
          @reject="p.applied = false"
        />
      </div>
    </div>

    <p v-if="error" class="chat__err">{{ error }}</p>

    <form class="chat__input" @submit.prevent="send">
      <textarea
        v-model="input"
        rows="2"
        placeholder="Type a message…"
        :disabled="streaming"
        @keydown.enter.exact.prevent="send"
      ></textarea>
      <button type="submit" class="chat__send" :disabled="streaming || !input.trim()">
        {{ streaming ? '…' : 'Send' }}
      </button>
    </form>
  </aside>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--pageLine);
  border-radius: 8px;
  background: var(--bBg);
  height: 100%;
  min-height: 0;
}
.chat__head {
  padding: 12px 14px;
  border-bottom: 1px solid var(--pageLine);
}
.chat__title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--pageMuted);
}
.chat__log {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.chat__empty {
  color: var(--pageMuted);
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.msg--user {
  align-items: flex-end;
}
.msg__body {
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 8px 11px;
  border-radius: 8px;
  max-width: 85%;
}
.msg--user .msg__body {
  background: var(--accent);
  color: white;
}
.msg--assistant .msg__body {
  background: var(--bPanel);
  color: var(--pageInk);
}
.msg__body--pending {
  color: var(--pageMuted);
}
.chat__err {
  color: #c83a3a;
  font-size: 12px;
  padding: 0 14px;
  margin: 0 0 6px;
}
.chat__input {
  display: flex;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--pageLine);
}
.chat__input textarea {
  flex: 1;
  resize: none;
  background: var(--bPanel);
  border: 1px solid var(--pageLine);
  border-radius: 5px;
  padding: 8px 10px;
  font-size: 14px;
  font-family: inherit;
  color: var(--pageInk);
}
.chat__send {
  align-self: flex-end;
  background: var(--accent);
  border: 1px solid var(--accent);
  color: white;
  border-radius: 5px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
}
.chat__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
