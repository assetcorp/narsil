import type { EngineCore } from '../engine/core'
import type { Narsil } from '../types/engine'

const engineCores = new WeakMap<Narsil, EngineCore>()

export function bindEngineCore(engine: Narsil, core: EngineCore): void {
  engineCores.set(engine, core)
}

export function engineCoreOf(engine: Narsil): EngineCore | undefined {
  return engineCores.get(engine)
}
