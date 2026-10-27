/**
 * Maps an array of items asynchronously with a strict concurrency limit.
 *
 * Ensures that at most `concurrency` asynchronous mapper operations run simultaneously.
 * Results preserve the original array order.
 *
 * @param items - Items to process
 * @param concurrency - Maximum number of operations executing at the same time
 * @param mapper - Async mapping function
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedLimit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await mapper(items[idx]!, idx);
    }
  }

  const workers = Array.from({ length: boundedLimit }, () => worker());
  await Promise.all(workers);

  return results;
}
