export const QUERY_CONCURRENCY = 8

/**
 * Runs one task per item, keeping at most `limit` of them in flight. The whole
 * run stops at the first failure, and `shouldStop` ends it between items.
 */
export async function runPooled<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, position: number) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0
  const workers: Array<Promise<void>> = []

  const pull = async (): Promise<void> => {
    for (;;) {
      const position = next++
      if (position >= items.length || shouldStop()) return
      await task(items[position], position)
    }
  }

  for (let worker = 0; worker < Math.min(limit, items.length); worker++) {
    workers.push(pull())
  }
  await Promise.all(workers)
}
