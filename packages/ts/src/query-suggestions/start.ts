import { attachedRuntimeOf, attachRuntime, installSuggestionHooks } from '#platform/suggestions-host'
import type { EngineCore } from '../engine/core'
import type { NarsilConfig } from '../types/config'
import type { Narsil } from '../types/engine'
import { createLocalHost } from './local-host'
import { createQuerySuggestionsRuntime, keyBytesOf, type QuerySuggestionsRuntime } from './runtime'

const starting = new WeakMap<EngineCore, Promise<QuerySuggestionsRuntime>>()

async function startRuntime(
  core: EngineCore,
  engine: Narsil,
  config: NarsilConfig | undefined,
): Promise<QuerySuggestionsRuntime> {
  const keySetting = config?.querySuggestions?.key
  const key = keySetting === undefined ? null : keyBytesOf(keySetting)
  const runtime = await createQuerySuggestionsRuntime(createLocalHost(core, engine, config), key)
  attachRuntime(core, runtime)
  installSuggestionHooks(core)
  await runtime.start()
  return runtime
}

export function localRuntimeOf(
  core: EngineCore,
  engine: Narsil,
  config: NarsilConfig | undefined,
): Promise<QuerySuggestionsRuntime> {
  const attached = attachedRuntimeOf(core)
  if (attached !== undefined) return Promise.resolve(attached)
  const pending = starting.get(core)
  if (pending !== undefined) return pending
  const started = startRuntime(core, engine, config)
  starting.set(core, started)
  void started.then(
    () => starting.delete(core),
    () => starting.delete(core),
  )
  return started
}
