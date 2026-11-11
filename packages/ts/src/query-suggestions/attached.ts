import type { EngineCore } from '../engine/core'
import type { QuerySuggestionsRuntime } from './runtime'

const runtimes = new WeakMap<EngineCore, QuerySuggestionsRuntime>()

export function attachRuntime(core: EngineCore, runtime: QuerySuggestionsRuntime): void {
  runtimes.set(core, runtime)
}

export function attachedRuntimeOf(core: EngineCore): QuerySuggestionsRuntime | undefined {
  return runtimes.get(core)
}
