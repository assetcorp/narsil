import { optionalCodeHost } from '../optional-code-host'

type RerankRuntime = typeof import('../../rerank/runtime')

let loaded: RerankRuntime | null = null

export function loadRerankRuntime(): Promise<RerankRuntime> {
  if (loaded !== null) return Promise.resolve(loaded)
  return import('../../rerank/runtime').then(runtime => {
    runtime.bindRerankHost(optionalCodeHost())
    loaded = runtime
    return runtime
  })
}

export function loadedRerankRuntime(): RerankRuntime | null {
  return loaded
}
