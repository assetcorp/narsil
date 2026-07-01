import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LatencySummary } from './types'

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

function makeSeededRng(seed: number): () => number {
  let s = seed | 0
  return (): number => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function bootstrapMedianCI(
  samples: number[],
  resampleCount = 2000,
  seed = 42,
): { lower: number; upper: number } {
  const n = samples.length
  if (n === 0) return { lower: 0, upper: 0 }
  const rng = makeSeededRng(seed)
  const medians = new Float64Array(resampleCount)
  const buf = new Float64Array(n)
  const mid = n >> 1
  for (let i = 0; i < resampleCount; i++) {
    for (let j = 0; j < n; j++) buf[j] = samples[Math.floor(rng() * n)]
    buf.sort()
    medians[i] = n % 2 ? buf[mid] : (buf[mid - 1] + buf[mid]) / 2
  }
  medians.sort()
  return {
    lower: medians[Math.floor(resampleCount * 0.025)],
    upper: medians[Math.floor(resampleCount * 0.975)],
  }
}

export function summarizeLatency(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    return { samples: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, ciLowerMs: 0, ciUpperMs: 0 }
  }
  let maxMs = samples[0]
  for (const v of samples) {
    if (v > maxMs) maxMs = v
  }
  const ci = bootstrapMedianCI(samples)
  return {
    samples: samples.length,
    meanMs: mean(samples),
    p50Ms: median(samples),
    p90Ms: percentile(samples, 90),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    maxMs,
    ciLowerMs: ci.lower,
    ciUpperMs: ci.upper,
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

function resolvePackageEntry(name: string): string | null {
  try {
    const metaResolve = (import.meta as unknown as { resolve?: (specifier: string) => string }).resolve
    if (typeof metaResolve === 'function') return fileURLToPath(metaResolve(name))
  } catch {
    // fall through to the CJS resolver
  }
  try {
    return createRequire(import.meta.url).resolve(name)
  } catch {
    return null
  }
}

// Many packages hide `./package.json` behind an `exports` map (and some, like
// `@delali/narsil`, expose no `require` condition at all), so a direct
// `require.resolve(name + '/package.json')` throws ERR_PACKAGE_PATH_NOT_EXPORTED.
// Resolve the package entry with the ESM resolver and walk up to the owning package.json.
export function getPackageVersion(name: string): string {
  try {
    const pkgPath = createRequire(import.meta.url).resolve(`${name}/package.json`)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    if (typeof pkg.version === 'string') return pkg.version
  } catch {
    // exports map does not expose ./package.json; walk up from the entry point below
  }
  const entry = resolvePackageEntry(name)
  if (entry === null) return 'unknown'
  let dir = dirname(entry)
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'))
        if (pkg.name === name && typeof pkg.version === 'string') return pkg.version
      } catch {
        // keep walking up on a malformed intermediate package.json
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
}
