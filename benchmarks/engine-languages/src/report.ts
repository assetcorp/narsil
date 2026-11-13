import type { Measurement, PhaseSummary } from './aggregate'
import type { EngineIdentity } from './engines/catalog'
import type { CrossEngineComparison, Verdict } from './oracle'
import type { EngineName, PhaseName } from './runner-output'
import type { WorkloadManifest } from './workload/format'

export const RESULTS_FORMAT = 1
export const RESULTS_FILE = 'results.json'
export const REPORT_FILE = 'report.md'
export const VERDICT_FILE = 'verdict.json'

const MEBIBYTE_BYTES = 1_048_576
const PHASE_LABELS: Record<PhaseName, string> = { keyword: 'Keyword', vector: 'Vector', hybrid: 'Hybrid' }

export interface MachineDescription {
  os: string
  arch: string
  cpu: string
  logicalCpus: number
  totalMemory: string
  machineLabel?: string
}

export interface LanguagesResults {
  format: number
  runId: string
  createdAt: string
  git: { branch: string; commit: string }
  machine: MachineDescription
  engines: Partial<Record<EngineName, EngineIdentity>>
  cCompiler: string
  workload: Pick<WorkloadManifest, 'keyword' | 'vector' | 'settings' | 'sha256'>
  repetitions: number
  threadCounts: number[]
  engineOrder: EngineName[][]
  measurements: Measurement[]
  crossEngine: CrossEngineComparison[]
  oracle: Verdict['oracle']
}

function rounded(value: number, digits: number): string {
  return value.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function recallCell(value: number | null): string {
  return value === null ? 'n/a' : rounded(value, 4)
}

function phaseRow(measurement: Measurement, phase: PhaseSummary): string {
  const qps = phase.queriesPerSecond
  return `| ${measurement.engine} | ${measurement.threads} | ${rounded(qps.median, 0)} (${rounded(qps.min, 0)} to ${rounded(qps.max, 0)}) | ${rounded(phase.p50Us, 1)} | ${rounded(phase.p99Us, 1)} |`
}

function phaseTable(measurements: readonly Measurement[], name: PhaseName): string[] {
  const rows = measurements.flatMap(measurement => {
    const phase = measurement.phases[name]
    return phase === undefined ? [] : [phaseRow(measurement, phase)]
  })
  return [
    `## ${PHASE_LABELS[name]} queries`,
    '',
    '| Engine | Threads | Queries per second, median (range) | p50 µs | p99 µs |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ]
}

function loadTable(measurements: readonly Measurement[]): string[] {
  return [
    '## Loading and memory',
    '',
    '| Engine | Workload | Threads | Documents | Documents per second | Resident MiB | Peak MiB |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...measurements.map(measurement => {
      const peak = measurement.memory.peakResidentBytes
      return `| ${measurement.engine} | ${measurement.workload} | ${measurement.threads} | ${rounded(measurement.load.documents, 0)} | ${rounded(measurement.load.documentsPerSecond.median, 0)} | ${rounded(measurement.memory.residentBytes / MEBIBYTE_BYTES, 1)} | ${peak === null ? 'n/a' : rounded(peak / MEBIBYTE_BYTES, 1)} |`
    }),
    '',
  ]
}

function qualityTable(measurements: readonly Measurement[]): string[] {
  return [
    '## Answers checked against the oracle',
    '',
    '| Engine | Threads | Recall@10 | Recall@100 | Hybrid recall@10 | Largest vector score error |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...measurements
      .filter(measurement => measurement.workload === 'vector')
      .map(measurement => {
        const quality = measurement.quality
        const error = quality.maxVectorScoreError === null ? 'n/a' : quality.maxVectorScoreError.toExponential(2)
        return `| ${measurement.engine} | ${measurement.threads} | ${recallCell(quality.recall10)} | ${recallCell(quality.recall100)} | ${recallCell(quality.hybridRecall10)} | ${error} |`
      }),
    '',
  ]
}

export function renderReport(results: LanguagesResults): string {
  const engines = Object.entries(results.engines).map(
    ([name, identity]) => `- ${name}: ${identity.package} ${identity.version}, ${identity.runtime}, ${identity.build}`,
  )
  const keyword = results.workload.keyword
  const vector = results.workload.vector
  return [
    '# Narsil in three languages',
    '',
    `Run ${results.runId} on ${results.machine.cpu} (${results.machine.logicalCpus} logical CPUs, ${results.machine.totalMemory}), ${results.machine.os} ${results.machine.arch}.`,
    '',
    ...engines,
    `- C compiler: ${results.cCompiler}`,
    '',
    `Keyword search uses ${rounded(keyword.documents, 0)} ${keyword.dataset} documents and ${rounded(keyword.queries, 0)} queries. ` +
      `Vector and hybrid search use ${rounded(vector.documents, 0)} ${vector.dataset} documents with ${vector.dimension}-dimension ${vector.model} vectors and ${rounded(vector.queries, 0)} queries. ` +
      `Every figure is the median of ${results.repetitions} repetitions, and the oracle checked every answer.`,
    '',
    ...phaseTable(results.measurements, 'keyword'),
    ...phaseTable(results.measurements, 'vector'),
    ...phaseTable(results.measurements, 'hybrid'),
    ...loadTable(results.measurements),
    ...qualityTable(results.measurements),
  ].join('\n')
}
