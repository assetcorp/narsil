import type { MemoryReading } from './engines/memory'
import type { OutputVerdict } from './oracle'
import {
  type EngineName,
  type MeasuredPhase,
  PHASES_BY_WORKLOAD,
  type PhaseName,
  type RunnerOutput,
} from './runner-output'
import type { WorkloadKind } from './workload/format'

const NANOSECONDS_PER_SECOND = 1e9
const NANOSECONDS_PER_MILLISECOND = 1e6
const NANOSECONDS_PER_MICROSECOND = 1e3
const MEDIAN_PERCENTILE = 50
const TAIL_PERCENTILE = 99

export interface MeasuredRun {
  repetition: number
  output: RunnerOutput
  memory: MemoryReading
}

export interface Spread {
  median: number
  min: number
  max: number
}

export interface PhaseSummary {
  queriesPerSecond: Spread
  p50Us: number
  p99Us: number
  latencySamples: number
  mismatches: number
}

export interface LoadSummary {
  documents: number
  documentsPerSecond: Spread
  insertMs: number
  optimizeMs: number
}

export interface MemorySummary {
  residentBytes: number
  peakResidentBytes: number | null
}

export interface QualitySummary {
  recall10: number | null
  recall100: number | null
  hybridRecall10: number | null
  maxVectorScoreError: number | null
}

export interface Measurement {
  engine: EngineName
  workload: WorkloadKind
  threads: number
  repetitions: number
  load: LoadSummary
  memory: MemorySummary
  phases: Partial<Record<PhaseName, PhaseSummary>>
  quality: QualitySummary
}

function middle(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const half = Math.floor(sorted.length / 2)
  const upper = sorted[half] ?? 0
  if (sorted.length % 2 === 1) return upper
  return ((sorted[half - 1] ?? upper) + upper) / 2
}

function spread(values: readonly number[]): Spread {
  return { median: middle(values), min: Math.min(...values), max: Math.max(...values) }
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length))
  return sorted[rank - 1] ?? 0
}

function pooledSorted(phases: readonly MeasuredPhase[]): Float64Array {
  const total = phases.reduce((sum, phase) => sum + phase.latencyNs.length, 0)
  const pooled = new Float64Array(total)
  let offset = 0
  for (const phase of phases) {
    pooled.set(phase.latencyNs, offset)
    offset += phase.latencyNs.length
  }
  return pooled.sort()
}

function summarisePhase(phases: readonly MeasuredPhase[]): PhaseSummary {
  const sorted = Array.from(pooledSorted(phases))
  return {
    queriesPerSecond: spread(
      phases.map(phase => (phase.queries * phase.passes * NANOSECONDS_PER_SECOND) / phase.wallNs),
    ),
    p50Us: nearestRank(sorted, MEDIAN_PERCENTILE) / NANOSECONDS_PER_MICROSECOND,
    p99Us: nearestRank(sorted, TAIL_PERCENTILE) / NANOSECONDS_PER_MICROSECOND,
    latencySamples: sorted.length,
    mismatches: phases.reduce((sum, phase) => sum + phase.mismatches, 0),
  }
}

function summariseLoad(runs: readonly MeasuredRun[]): LoadSummary {
  const documents = runs[0]?.output.load.documents ?? 0
  return {
    documents,
    documentsPerSecond: spread(
      runs.map(
        run =>
          (run.output.load.documents * NANOSECONDS_PER_SECOND) /
          (run.output.load.insertNs + run.output.load.optimizeNs),
      ),
    ),
    insertMs: middle(runs.map(run => run.output.load.insertNs / NANOSECONDS_PER_MILLISECOND)),
    optimizeMs: middle(runs.map(run => run.output.load.optimizeNs / NANOSECONDS_PER_MILLISECOND)),
  }
}

function summariseMemory(runs: readonly MeasuredRun[]): MemorySummary {
  const peaks = runs.map(run => run.memory.peakResidentBytes).filter((peak): peak is number => peak !== null)
  return {
    residentBytes: middle(runs.map(run => run.memory.residentBytes)),
    peakResidentBytes: peaks.length === runs.length ? middle(peaks) : null,
  }
}

function meanOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return null
  return present.reduce((sum, value) => sum + value, 0) / present.length
}

function summariseQuality(verdicts: readonly OutputVerdict[]): QualitySummary {
  const errors = verdicts.map(verdict => verdict.maxVectorScoreError).filter((error): error is number => error !== null)
  return {
    recall10: meanOf(verdicts.map(verdict => verdict.recall10)),
    recall100: meanOf(verdicts.map(verdict => verdict.recall100)),
    hybridRecall10: meanOf(verdicts.map(verdict => verdict.hybridRecall10)),
    maxVectorScoreError: errors.length === 0 ? null : Math.max(...errors),
  }
}

export function summarise<Run extends MeasuredRun>(
  runs: readonly Run[],
  verdicts: ReadonlyMap<string, OutputVerdict>,
  sourceOf: (run: Run) => string,
): Measurement[] {
  const groups = new Map<string, Run[]>()
  for (const run of runs) {
    const key = `${run.output.engine}/${run.output.workload}/${run.output.threads}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [run])
    else group.push(run)
  }
  const measurements: Measurement[] = []
  for (const group of groups.values()) {
    const first = group[0]
    if (first === undefined) continue
    const { engine, workload, threads } = first.output
    const phases: Partial<Record<PhaseName, PhaseSummary>> = {}
    for (const name of PHASES_BY_WORKLOAD[workload]) {
      const measured = group
        .map(run => run.output.phases[name])
        .filter((phase): phase is MeasuredPhase => phase !== undefined)
      phases[name] = summarisePhase(measured)
    }
    const groupVerdicts = group
      .map(run => verdicts.get(sourceOf(run)))
      .filter((verdict): verdict is OutputVerdict => verdict !== undefined)
    if (groupVerdicts.length !== group.length) {
      throw new Error(`the oracle verdict lacks some ${engine} ${workload} outputs on ${threads} threads`)
    }
    measurements.push({
      engine,
      workload,
      threads,
      repetitions: group.length,
      load: summariseLoad(group),
      memory: summariseMemory(group),
      phases,
      quality: summariseQuality(groupVerdicts),
    })
  }
  return measurements
}
