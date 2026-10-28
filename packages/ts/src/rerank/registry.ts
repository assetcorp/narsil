import type { EngineCore } from '../engine/core'
import { ErrorCodes, NarsilError } from '../errors'
import type { RerankAdapter } from '../types/adapters'

export function validateRerankAdapter(name: unknown, adapter: unknown): asserts adapter is RerankAdapter {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, 'A rerank adapter needs a non-empty string name')
  }
  const rerank = typeof adapter === 'object' && adapter !== null ? (adapter as { rerank?: unknown }).rerank : undefined
  if (typeof rerank !== 'function') {
    throw new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, `Rerank adapter "${name}" must provide a rerank function`, {
      adapter: name,
    })
  }
}

export function registerEngineRerankAdapter(core: EngineCore, name: string, adapter: RerankAdapter): void {
  core.guardShutdown()
  validateRerankAdapter(name, adapter)
  core.rerankAdapters.set(name, adapter)
}

export async function shutdownRerankAdapters(adapters: Map<string, RerankAdapter>): Promise<void> {
  const distinct = new Set(adapters.values())
  adapters.clear()
  for (const adapter of distinct) {
    try {
      await adapter.shutdown?.()
    } catch {}
  }
}
