export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  action: (item: T, index: number) => Promise<void>,
) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Concurrency must be a positive integer.");
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await action(items[index], index);
    }
  });
  await Promise.all(workers);
}
