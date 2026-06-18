<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

defineProps<{ label: string }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

function toggle() {
  open.value = !open.value;
}
function close() {
  open.value = false;
}
function onDocClick(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="root" class="menu">
    <button class="trigger" :class="{ active: open }" @click="toggle">
      {{ label }} <span class="caret">▾</span>
    </button>
    <!-- Any click inside an item closes the menu. -->
    <div v-if="open" class="panel" @click="close">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.menu {
  position: relative;
  display: inline-block;
}
.trigger {
  background: transparent;
  border: 1px solid var(--pageLine);
  padding: 8px 14px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  color: var(--pageInk);
  letter-spacing: 0.06em;
}
.trigger.active {
  border-color: var(--accent);
  color: var(--accent);
}
.caret {
  font-size: 9px;
  opacity: 0.7;
}
.panel {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 190px;
  background: var(--bBg);
  border: 1px solid var(--pageLine);
  border-radius: 8px;
  box-shadow: 0 12px 34px var(--bShadow);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* Style whatever buttons the parent drops in as uniform menu rows. */
.panel :deep(button) {
  display: flex;
  align-items: center;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 9px 12px;
  border-radius: 5px;
  font-size: 13px;
  color: var(--pageInk);
  cursor: pointer;
  letter-spacing: 0.02em;
}
.panel :deep(button:hover:not(:disabled)) {
  background: var(--bPanel);
}
.panel :deep(button:disabled) {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
