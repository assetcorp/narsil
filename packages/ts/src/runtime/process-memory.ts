import type { ProcessMemoryReport } from '../types/results'

interface NodeLikeProcess {
  memoryUsage?: () => { heapUsed: number; heapTotal: number; external: number; rss: number }
}

/**
 * Read the host runtime's V8 heap usage. Returns `null` in browsers and any
 * environment that does not expose `process.memoryUsage` (Node, Bun, and Deno
 * all expose it). The numbers describe the entire host process, not a single
 * Narsil engine; callers running multiple engines in one process must account
 * for the overcount.
 */
export function readProcessMemory(): ProcessMemoryReport | null {
  const proc = (globalThis as Record<string, unknown>).process as NodeLikeProcess | undefined
  if (!proc || typeof proc.memoryUsage !== 'function') {
    return null
  }
  try {
    const usage = proc.memoryUsage()
    if (
      !Number.isFinite(usage.heapUsed) ||
      !Number.isFinite(usage.heapTotal) ||
      !Number.isFinite(usage.external) ||
      !Number.isFinite(usage.rss)
    ) {
      return null
    }
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
    }
  } catch {
    return null
  }
}
