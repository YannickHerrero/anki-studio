export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let done = 0;
  const total = items.length;

  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      const item = items[i]!;
      results[i] = await fn(item, i);
      done++;
      onProgress?.(done, total);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker);
  await Promise.all(workers);
  return results;
}
