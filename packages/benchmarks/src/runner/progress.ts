import type {
  BenchmarkOutput,
  CranfieldQualityResult,
  MutationResult,
  QualityResult,
  ScaleResult,
  SerializationResult,
  VectorScaleResult,
} from '../types'
import { writeJsonAtomicSync } from './atomic-write'

interface BenchmarkOutputExtras {
  scenarios?: unknown
  vectorByDimension?: Record<number, Record<string, Record<number, VectorScaleResult>>>
}

export type LiveBenchmarkOutput = BenchmarkOutput & BenchmarkOutputExtras

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

function ensureNumericKeyed<V>(parent: Record<number, V>, key: number, factory: () => V): V {
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

function ensureVectorBucket(state: BenchmarkOutput): Record<string, Record<number, VectorScaleResult>> {
  const current = state.tiers.vector
  if (current !== undefined) return current
  const created: Record<string, Record<number, VectorScaleResult>> = {}
  state.tiers.vector = created
  return created
}

function ensureVectorByDimension(
  state: LiveBenchmarkOutput,
): Record<number, Record<string, Record<number, VectorScaleResult>>> {
  if (state.vectorByDimension !== undefined) return state.vectorByDimension
  const created: Record<number, Record<string, Record<number, VectorScaleResult>>> = {}
  state.vectorByDimension = created
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

function ensureQualityBucket(state: BenchmarkOutput): Record<string, QualityResult> {
  if (state.quality !== undefined) return state.quality
  const created: Record<string, QualityResult> = {}
  state.quality = created
  return created
}

function ensureCranfieldBucket(state: BenchmarkOutput): Record<string, CranfieldQualityResult> {
  if (state.cranfieldQuality !== undefined) return state.cranfieldQuality
  const created: Record<string, CranfieldQualityResult> = {}
  state.cranfieldQuality = created
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

  setVectorScale(engine: string, scale: number, dimension: number, result: VectorScaleResult): void {
    const primary = ensureVectorBucket(this.state)
    const primaryBucket = ensureRecord(primary, engine, () => ({}) as Record<number, VectorScaleResult>)
    primaryBucket[scale] = result

    const byDim = ensureVectorByDimension(this.state)
    const dimBucket = ensureNumericKeyed(
      byDim,
      dimension,
      () => ({}) as Record<string, Record<number, VectorScaleResult>>,
    )
    const dimEngineBucket = ensureRecord(dimBucket, engine, () => ({}) as Record<number, VectorScaleResult>)
    dimEngineBucket[scale] = result
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

  setQuality(engine: string, result: QualityResult): void {
    const bucket = ensureQualityBucket(this.state)
    bucket[engine] = result
    this.flush()
  }

  setCranfield(engine: string, result: CranfieldQualityResult): void {
    const bucket = ensureCranfieldBucket(this.state)
    bucket[engine] = result
    this.flush()
  }

  promoteVectorPrimary(dimension: number): void {
    const byDim = this.state.vectorByDimension
    if (!byDim) return
    const dimBucket = byDim[dimension]
    if (!dimBucket) return
    this.state.tiers.vector = dimBucket
    this.flush()
  }
}
