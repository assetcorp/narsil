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

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  let sumSqDiff = 0
  for (const v of values) {
    const diff = v - avg
    sumSqDiff += diff * diff
  }
  return Math.sqrt(sumSqDiff / (values.length - 1))
}

export function coefficientOfVariation(values: number[]): number {
  const avg = mean(values)
  if (avg === 0) return 0
  return stddev(values) / avg
}

export interface BootstrapCI {
  speedup: number
  ciLower: number
  ciUpper: number
}

export function bootstrapSpeedupCI(
  baselineSamples: number[],
  candidateSamples: number[],
  resampleCount = 10_000,
  seed = 42,
): BootstrapCI {
  if (baselineSamples.length === 0 || candidateSamples.length === 0) {
    return { speedup: 0, ciLower: 0, ciUpper: 0 }
  }

  let s = seed | 0
  const rng = (): number => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const baselineMean = mean(baselineSamples)
  const candidateMean = mean(candidateSamples)
  const observedSpeedup = baselineMean === 0 ? 0 : candidateMean / baselineMean

  const speedups = new Float64Array(resampleCount)
  const bLen = baselineSamples.length
  const cLen = candidateSamples.length

  for (let i = 0; i < resampleCount; i++) {
    let bSum = 0
    let cSum = 0
    for (let j = 0; j < bLen; j++) {
      bSum += baselineSamples[Math.floor(rng() * bLen)]
    }
    for (let j = 0; j < cLen; j++) {
      cSum += candidateSamples[Math.floor(rng() * cLen)]
    }
    const bMean = bSum / bLen
    const cMean = cSum / cLen
    speedups[i] = bMean === 0 ? 0 : cMean / bMean
  }

  speedups.sort()

  const lo = Math.floor(resampleCount * 0.025)
  const hi = Math.floor(resampleCount * 0.975)

  return {
    speedup: observedSpeedup,
    ciLower: speedups[lo],
    ciUpper: speedups[hi],
  }
}

export function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
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
