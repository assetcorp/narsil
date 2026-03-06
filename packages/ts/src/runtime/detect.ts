export interface RuntimeInfo {
  runtime: 'node' | 'browser' | 'deno' | 'bun'
  supportsWorkerThreads: boolean
  supportsWebWorkers: boolean
  supportsFileSystem: boolean
  supportsIndexedDB: boolean
  supportsBroadcastChannel: boolean
  cpuCount: number
}

function detectRuntimeName(): RuntimeInfo['runtime'] {
  if ('Bun' in globalThis) {
    return 'bun'
  }
  if ('Deno' in globalThis) {
    return 'deno'
  }
  const proc = (globalThis as Record<string, unknown>).process
  if (
    typeof proc === 'object' &&
    proc !== null &&
    typeof (proc as Record<string, unknown>).versions === 'object' &&
    typeof ((proc as Record<string, unknown>).versions as Record<string, unknown>)?.node === 'string'
  ) {
    return 'node'
  }
  return 'browser'
}

function getCpuCount(): number {
  const nav = (globalThis as Record<string, unknown>).navigator as { hardwareConcurrency?: number } | undefined
  if (nav && typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency >= 1) {
    return nav.hardwareConcurrency
  }
  return 1
}

export function detectRuntime(): RuntimeInfo {
  const runtime = detectRuntimeName()

  return {
    runtime,
    cpuCount: getCpuCount(),
    supportsWorkerThreads: runtime === 'node' || runtime === 'bun',
    supportsWebWorkers: runtime === 'browser' || runtime === 'deno' || runtime === 'bun',
    supportsFileSystem: runtime === 'node' || runtime === 'bun' || runtime === 'deno',
    supportsIndexedDB: runtime === 'browser' || 'indexedDB' in globalThis,
    supportsBroadcastChannel: 'BroadcastChannel' in globalThis,
  }
}
