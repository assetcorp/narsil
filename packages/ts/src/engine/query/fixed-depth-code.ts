type RerankRuntime = typeof import('../../rerank/runtime')

let loaded: RerankRuntime | null = null

export function loadRerankRuntime(): Promise<RerankRuntime> {
  if (loaded !== null) return Promise.resolve(loaded)
  return import('../../rerank/runtime').then(runtime => {
    loaded = runtime
    return runtime
  })
}

export function loadedRerankRuntime(): RerankRuntime | null {
  return loaded
}
