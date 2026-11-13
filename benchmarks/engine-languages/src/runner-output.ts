import type { WorkloadKind } from './workload/format'

export type EngineName = 'typescript' | 'rust' | 'go'
export const ENGINE_NAMES: readonly EngineName[] = ['typescript', 'rust', 'go']

export type VerificationName = 'keyword' | 'vector' | 'vectorLeg' | 'vectorDeep' | 'textLeg' | 'hybrid'
export type PhaseName = 'keyword' | 'vector' | 'hybrid'

export const PHASES_BY_WORKLOAD: Record<WorkloadKind, readonly PhaseName[]> = {
  keyword: ['keyword'],
  vector: ['vector', 'hybrid'],
}

export const MEMORY_READY_LINE = 'memory-ready'
export const MEMORY_MEASURED_LINE = 'memory-measured'

export type RunnerHit = [string, number]

export interface VerifiedAnswer {
  count: number
  countExact: boolean
  hits: RunnerHit[]
}

export interface MeasuredPhase {
  queries: number
  warmupPasses: number
  passes: number
  threads: number
  wallNs: number
  latencyNs: number[]
  mismatches: number
}

export interface RunnerLoad {
  documents: number
  insertNs: number
  optimizeNs: number
  readyNs: number
}

export interface RunnerOutput {
  engine: EngineName
  workload: WorkloadKind
  threads: number
  load: RunnerLoad
  verification: Partial<Record<VerificationName, VerifiedAnswer[]>>
  phases: Partial<Record<PhaseName, MeasuredPhase>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wholeNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`runner output: ${what} must be a whole number of at least 0`)
  }
  return value
}

function parsePhase(raw: unknown, name: string): MeasuredPhase {
  if (!isRecord(raw)) throw new Error(`runner output: phase ${name} is missing`)
  const latencies = raw.latencyNs
  if (!Array.isArray(latencies)) throw new Error(`runner output: phase ${name} has no latencyNs list`)
  const phase: MeasuredPhase = {
    queries: wholeNumber(raw.queries, `${name}.queries`),
    warmupPasses: wholeNumber(raw.warmupPasses, `${name}.warmupPasses`),
    passes: wholeNumber(raw.passes, `${name}.passes`),
    threads: wholeNumber(raw.threads, `${name}.threads`),
    wallNs: wholeNumber(raw.wallNs, `${name}.wallNs`),
    latencyNs: latencies.map((value, index) => wholeNumber(value, `${name}.latencyNs[${index}]`)),
    mismatches: wholeNumber(raw.mismatches, `${name}.mismatches`),
  }
  if (phase.latencyNs.length !== phase.queries * phase.passes) {
    throw new Error(
      `runner output: phase ${name} records ${phase.latencyNs.length} latencies for ${phase.queries} queries over ${phase.passes} passes`,
    )
  }
  if (phase.wallNs === 0) throw new Error(`runner output: phase ${name} took no time`)
  return phase
}

export function parseRunnerOutput(
  text: string,
  expected: { engine: EngineName; workload: WorkloadKind; threads: number },
): RunnerOutput {
  const raw: unknown = JSON.parse(text)
  if (!isRecord(raw)) throw new Error('runner output must be a JSON object')
  if (raw.engine !== expected.engine || raw.workload !== expected.workload || raw.threads !== expected.threads) {
    throw new Error(
      `runner output names ${String(raw.engine)}, ${String(raw.workload)}, ${String(raw.threads)} threads, ` +
        `while the driver started ${expected.engine}, ${expected.workload}, ${expected.threads} threads`,
    )
  }
  const load = raw.load
  if (!isRecord(load)) throw new Error('runner output: load is missing')
  const phasesRaw = raw.phases
  if (!isRecord(phasesRaw)) throw new Error('runner output: phases are missing')
  const phases: Partial<Record<PhaseName, MeasuredPhase>> = {}
  for (const name of PHASES_BY_WORKLOAD[expected.workload]) {
    phases[name] = parsePhase(phasesRaw[name], name)
    if (phases[name].threads !== expected.threads) {
      throw new Error(`runner output: phase ${name} ran on ${phases[name].threads} threads`)
    }
  }
  return {
    engine: expected.engine,
    workload: expected.workload,
    threads: expected.threads,
    load: {
      documents: wholeNumber(load.documents, 'load.documents'),
      insertNs: wholeNumber(load.insertNs, 'load.insertNs'),
      optimizeNs: wholeNumber(load.optimizeNs, 'load.optimizeNs'),
      readyNs: wholeNumber(load.readyNs, 'load.readyNs'),
    },
    verification: {},
    phases,
  }
}
