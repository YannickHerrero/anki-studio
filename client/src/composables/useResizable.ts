import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue';

export type ResizableAxis = 'x' | 'y';

export type UseResizableOptions = {
  /** localStorage key. If absent, sizes are not persisted. */
  key?: string;
  axis: ResizableAxis;
  min: number;
  /** Pixel cap, or a callback that returns one (re-evaluated on each move). */
  max: number | (() => number);
  initial: number;
};

function readPersisted(key: string | undefined): number | null {
  if (!key || typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clamp(n: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(n, min), max);
}

export function useResizable(opts: UseResizableOptions): {
  size: Ref<number>;
  dragging: Ref<boolean>;
  start: (e: PointerEvent) => void;
  clampToMax: () => void;
} {
  const persisted = readPersisted(opts.key);
  const size = ref<number>(persisted ?? opts.initial);
  const dragging = ref(false);

  const resolveMax = () =>
    typeof opts.max === 'function' ? opts.max() : opts.max;

  let startCoord = 0;
  let startSize = 0;

  function onMove(e: PointerEvent) {
    const delta = (opts.axis === 'x' ? e.clientX : e.clientY) - startCoord;
    size.value = clamp(startSize + delta, opts.min, resolveMax());
  }

  function onUp() {
    dragging.value = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function start(e: PointerEvent) {
    e.preventDefault();
    dragging.value = true;
    startCoord = opts.axis === 'x' ? e.clientX : e.clientY;
    startSize = size.value;
    document.body.style.cursor = opts.axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  function clampToMax() {
    size.value = clamp(size.value, opts.min, resolveMax());
  }

  if (opts.key) {
    watch(size, (v) => {
      try {
        window.localStorage.setItem(opts.key!, String(Math.round(v)));
      } catch {
        // Ignore quota / privacy-mode failures — the size is still applied
        // in-memory for this session.
      }
    });
  }

  onUnmounted(() => {
    // Defensive: if the component unmounts mid-drag, drop listeners.
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Re-clamp on mount in case the persisted value is now out of bounds
  // (e.g. the viewport shrank between sessions).
  onMounted(clampToMax);

  return { size, dragging, start, clampToMax };
}
