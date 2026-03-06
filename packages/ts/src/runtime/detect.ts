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
  if (typeof globalThis !== 'undefined' && 'Bun' in globalThis) {
    return 'bun'
  }
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    return 'deno'
  }
  if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as Record<string, unknown>).process === 'object' &&
    typeof ((globalThis as Record<string, unknown>).process as Record<string, unknown>)?.versions === 'object' &&
    typeof (
      ((globalThis as Record<string, unknown>).process as Record<string, unknown>)?.versions as Record<string, unknown>
    )?.node === 'string'
  ) {
    return 'node'
  }
  return 'browser'
}

async function getCpuCount(runtime: RuntimeInfo['runtime']): Promise<number> {
  if (runtime === 'node' || runtime === 'bun') {
    try {
      const os = await import('node:os')
      return os.cpus().length
    } catch {
      return 1
    }
  }
  const nav = (globalThis as Record<string, unknown>).navigator as { hardwareConcurrency?: number } | undefined
  if (nav && typeof nav.hardwareConcurrency === 'number') {
    return nav.hardwareConcurrency
  }
  return 1
}

export async function detectRuntime(): Promise<RuntimeInfo> {
  const runtime = detectRuntimeName()
  const cpuCount = await getCpuCount(runtime)

  return {
    runtime,
    cpuCount,

    supportsWorkerThreads: runtime === 'node' || runtime === 'bun',

    supportsWebWorkers: runtime === 'browser' || runtime === 'deno' || runtime === 'bun',

    supportsFileSystem: runtime === 'node' || runtime === 'bun' || runtime === 'deno',

    supportsIndexedDB: runtime === 'browser' || (typeof globalThis !== 'undefined' && 'indexedDB' in globalThis),

    supportsBroadcastChannel: typeof globalThis !== 'undefined' && 'BroadcastChannel' in globalThis,
  }
}
