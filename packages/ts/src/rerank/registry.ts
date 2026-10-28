import type { EngineCore } from '../engine/core'
import { ErrorCodes, NarsilError } from '../errors'
import type { RerankAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import {
  DEFAULT_MAX_RERANK_WINDOW,
  DEFAULT_RERANK_TIMEOUT_MS,
  MAX_RERANK_TIMEOUT_MS,
  MAX_RERANK_WINDOW,
} from './constants'

export interface RerankSettings {
  timeoutMs: number
  maxWindow: number
}

function wholeNumberIn(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
}

export function resolveRerankSettings(config: NarsilConfig | undefined): RerankSettings {
  const timeout: unknown = config?.rerankTimeout
  const maxWindow: unknown = config?.maxRerankWindow
  if (timeout !== undefined && !wholeNumberIn(timeout, 1, MAX_RERANK_TIMEOUT_MS)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `rerankTimeout must be a whole number of milliseconds from 1 to ${MAX_RERANK_TIMEOUT_MS}`,
      { rerankTimeout: timeout },
    )
  }
  if (maxWindow !== undefined && !wholeNumberIn(maxWindow, 1, MAX_RERANK_WINDOW)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `maxRerankWindow must be a whole number from 1 to ${MAX_RERANK_WINDOW}`,
      {
        maxRerankWindow: maxWindow,
      },
    )
  }
  return {
    timeoutMs: timeout ?? DEFAULT_RERANK_TIMEOUT_MS,
    maxWindow: maxWindow ?? DEFAULT_MAX_RERANK_WINDOW,
  }
}

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
