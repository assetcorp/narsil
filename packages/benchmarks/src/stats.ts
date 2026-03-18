import { createRequire } from 'node:module'

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

export function tryGc(): void {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
  }
}

export function getPackageVersion(name: string): string {
  const require = createRequire(import.meta.url)
  try {
    const pkgPath = require.resolve(`${name}/package.json`)
    return JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf-8')).version
  } catch {
    return 'unknown'
  }
}
