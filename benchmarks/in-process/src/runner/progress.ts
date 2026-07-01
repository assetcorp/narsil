import type {
  BenchmarkOutput,
  ConsistencyReport,
  MutationResult,
  RelevanceDatasetInfo,
  RelevanceQualityResult,
  ScaleResult,
  SerializationResult,
  VectorRelevanceResult,
} from '../types'
import { writeJsonAtomicSync } from './atomic-write'

export type LiveBenchmarkOutput = BenchmarkOutput

export interface ProgressStoreOptions {
  outputPath: string
  initial: LiveBenchmarkOutput
}

function ensureRecord<V>(parent: Record<string, V>, key: string, factory: () => V): V {
  const existing = parent[key]
  if (existing !== undefined) return existing
  const created = factory()
  parent[key] = created
  return created
}

function ensureScaleBucket(
  state: BenchmarkOutput,
  section: 'textOnly' | 'fullSchema',
): Record<string, Record<number, ScaleResult>> {
  const current = state.tiers[section]
  if (current !== undefined) return current
  const created: Record<string, Record<number, ScaleResult>> = {}
  state.tiers[section] = created
  return created
}

function ensureVectorRelevanceBucket(state: BenchmarkOutput): Record<string, Record<string, VectorRelevanceResult>> {
  if (state.vectorRelevance !== undefined) return state.vectorRelevance
  const created: Record<string, Record<string, VectorRelevanceResult>> = {}
  state.vectorRelevance = created
  return created
}

function ensureSerializationBucket(state: BenchmarkOutput): Record<string, SerializationResult> {
  if (state.serialization !== undefined) return state.serialization
  const created: Record<string, SerializationResult> = {}
  state.serialization = created
  return created
}

function ensureMutationBucket(state: BenchmarkOutput): Record<string, MutationResult> {
  if (state.mutations !== undefined) return state.mutations
  const created: Record<string, MutationResult> = {}
  state.mutations = created
  return created
}

function ensureRelevanceBucket(state: BenchmarkOutput): Record<string, RelevanceQualityResult> {
  if (state.relevanceQuality !== undefined) return state.relevanceQuality
  const created: Record<string, RelevanceQualityResult> = {}
  state.relevanceQuality = created
  return created
}

export class ProgressStore {
  private readonly outputPath: string
  private readonly state: LiveBenchmarkOutput

  constructor(options: ProgressStoreOptions) {
    this.outputPath = options.outputPath
    this.state = options.initial
  }

  snapshot(): LiveBenchmarkOutput {
    return this.state
  }

  flush(): void {
    writeJsonAtomicSync(this.outputPath, this.state)
  }

  setTextScale(section: 'textOnly' | 'fullSchema', engine: string, scale: number, result: ScaleResult): void {
    const bucket = ensureScaleBucket(this.state, section)
    const engineBucket = ensureRecord(bucket, engine, () => ({}) as Record<number, ScaleResult>)
    engineBucket[scale] = result
    this.flush()
  }

  setVectorRelevance(engine: string, dataset: string, result: VectorRelevanceResult): void {
    const bucket = ensureVectorRelevanceBucket(this.state)
    const engineBucket = ensureRecord(bucket, engine, () => ({}) as Record<string, VectorRelevanceResult>)
    engineBucket[dataset] = result
    this.flush()
  }

  setSerialization(engine: string, result: SerializationResult): void {
    const bucket = ensureSerializationBucket(this.state)
    bucket[engine] = result
    this.flush()
  }

  setMutation(engine: string, result: MutationResult): void {
    const bucket = ensureMutationBucket(this.state)
    bucket[engine] = result
    this.flush()
  }

  setRelevance(engine: string, result: RelevanceQualityResult): void {
    const bucket = ensureRelevanceBucket(this.state)
    bucket[engine] = result
    this.flush()
  }

  setRelevanceDataset(info: RelevanceDatasetInfo): void {
    this.state.relevanceDataset = info
    this.flush()
  }

  setConsistency(report: ConsistencyReport): void {
    this.state.consistency = report
    this.flush()
  }
}
