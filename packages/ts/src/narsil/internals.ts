import type { EngineCore } from '../engine/core'
import type { Narsil } from '../types/engine'

const engineCores = new WeakMap<Narsil, EngineCore>()
const rerankWindowSources = new WeakMap<object, () => number | undefined>()

export function bindEngineCore(engine: Narsil, core: EngineCore): void {
  engineCores.set(engine, core)
}

export function engineCoreOf(engine: Narsil): EngineCore | undefined {
  return engineCores.get(engine)
}

export function bindRerankWindowSource(owner: object, read: () => number | undefined): void {
  rerankWindowSources.set(owner, read)
}

export function rerankWindowCapOf(owner: object): number | undefined {
  const core = engineCores.get(owner as Narsil)
  if (core !== undefined) return core.rerankSettings.maxWindow
  return rerankWindowSources.get(owner)?.()
}
