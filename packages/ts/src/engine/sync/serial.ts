const chainsByRegistry = new WeakMap<object, Map<string, Promise<unknown>>>()

export async function oneSyncChangeAtATime<T>(
  registry: object,
  indexName: string,
  action: () => Promise<T>,
): Promise<T> {
  let chains = chainsByRegistry.get(registry)
  if (chains === undefined) {
    chains = new Map()
    chainsByRegistry.set(registry, chains)
  }
  const running = chains
  const current = (running.get(indexName) ?? Promise.resolve()).catch(() => undefined).then(action)
  running.set(indexName, current)
  try {
    return await current
  } finally {
    if (running.get(indexName) === current) running.delete(indexName)
  }
}
