<script setup lang="ts">
import type { ResizableAxis } from '../composables/useResizable';

defineProps<{
  axis: ResizableAxis;
  active?: boolean;
}>();
const emit = defineEmits<{ (e: 'start', ev: PointerEvent): void }>();

function onPointerDown(e: PointerEvent) {
  emit('start', e);
}
</script>

<template>
  <div
    class="rhandle"
    :class="[`rhandle--${axis}`, active ? 'rhandle--active' : '']"
    @pointerdown="onPointerDown"
    role="separator"
    :aria-orientation="axis === 'x' ? 'vertical' : 'horizontal'"
  >
    <div class="rhandle__grip"></div>
  </div>
</template>

<style scoped>
.rhandle {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
}
.rhandle--x {
  width: 6px;
  cursor: col-resize;
}
.rhandle--y {
  height: 6px;
  cursor: row-resize;
}
.rhandle__grip {
  background: transparent;
  transition: background 120ms ease;
}
.rhandle--x .rhandle__grip {
  width: 2px;
  height: 32px;
  border-radius: 2px;
}
.rhandle--y .rhandle__grip {
  height: 2px;
  width: 32px;
  border-radius: 2px;
}
.rhandle:hover .rhandle__grip,
.rhandle--active .rhandle__grip {
  background: var(--accent);
}
</style>
