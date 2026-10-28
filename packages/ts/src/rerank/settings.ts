import { ErrorCodes, NarsilError } from '../errors'
import type { RerankAdapter } from '../types/adapters'
import type { NarsilConfig } from '../types/config'
import {
  DEFAULT_MAX_RERANK_WINDOW,
  DEFAULT_RERANK_TIMEOUT_MS,
  MAX_RERANK_TIMEOUT_MS,
  MAX_RERANK_WINDOW,
  MIN_RERANK_TIMEOUT_MS,
  MIN_RERANK_WINDOW,
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
  if (timeout !== undefined && !wholeNumberIn(timeout, MIN_RERANK_TIMEOUT_MS, MAX_RERANK_TIMEOUT_MS)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `rerankTimeout must be a whole number of milliseconds from ${MIN_RERANK_TIMEOUT_MS} to ${MAX_RERANK_TIMEOUT_MS}`,
      { rerankTimeout: timeout },
    )
  }
  if (maxWindow !== undefined && !wholeNumberIn(maxWindow, MIN_RERANK_WINDOW, MAX_RERANK_WINDOW)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `maxRerankWindow must be a whole number from ${MIN_RERANK_WINDOW} to ${MAX_RERANK_WINDOW}`,
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

export async function shutdownRerankAdapters(adapters: Map<string, RerankAdapter>): Promise<void> {
  const distinct = new Set(adapters.values())
  adapters.clear()
  for (const adapter of distinct) {
    try {
      await adapter.shutdown?.()
    } catch {}
  }
}
