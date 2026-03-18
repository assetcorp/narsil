export interface BenchDocument {
  id: string
  title: string
  body: string
  score: number
  category: string
}

export interface VectorBenchDocument {
  id: string
  title: string
  embedding: number[]
}

export interface SearchEngine {
  name: string
  create(): Promise<void>
  insert(documents: BenchDocument[]): Promise<void>
  search(query: string): Promise<number>
  searchTermMatchAll?(query: string): Promise<number>
  searchWithFilter?(query: string): Promise<number>
  searchWithIds?(query: string): Promise<string[]>
  remove?(docId: string): Promise<void>
  insertWithIds?(documents: BenchDocument[]): Promise<void>
  insertedIds?: string[]
  teardown(): Promise<void>
}

export interface SerializableEngine {
  name: string
  create(): Promise<void>
  insert(documents: BenchDocument[]): Promise<void>
  serialize(): Promise<Uint8Array | string>
  deserializeAndSearch(serialized: Uint8Array | string, query: string): Promise<number>
  teardown(): Promise<void>
}

export interface SerializationResult {
  serializeMs: number
  serializedBytes: number
  deserializeAndSearchMs: number
}

export interface VectorSearchEngine {
  name: string
  create(): Promise<void>
  insert(documents: VectorBenchDocument[]): Promise<void>
  searchVector(queryVector: number[], k: number): Promise<number>
  teardown(): Promise<void>
}

export interface ScaleResult {
  insertMedianMs: number
  insertDocsPerSec: number
  searchMedianMs: number
  searchP95Ms: number
  searchAllTermsMedianMs?: number
  searchAllTermsP95Ms?: number
  filteredSearchMedianMs?: number
  filteredSearchP95Ms?: number
  memoryMb: number
}

export interface VectorScaleResult {
  insertMedianMs: number
  insertDocsPerSec: number
  searchMedianMs: number
  searchP95Ms: number
  memoryMb: number
}

export interface EnvironmentInfo {
  node: string
  os: string
  arch: string
  cpu: string
  totalMemory: string
}

export interface BenchmarkConfig {
  scales: number[]
  vectorScales: number[]
  vectorDimension: number
  insertIterations: number
  warmupIterations: number
  searchQueryCount: number
  seed: number
}

export interface TierResults {
  textOnly: Record<string, Record<number, ScaleResult>>
  fullSchema: Record<string, Record<number, ScaleResult>>
  vector: Record<string, Record<number, VectorScaleResult>>
}

export interface MutationResult {
  removeDocsPerSec: number
  removeMedianMs: number
  searchAfterRemoveMedianMs: number
  reinsertDocsPerSec: number
}

export interface QualityResult {
  meanNdcg10: number
  queryCount: number
  docCount: number
}

export interface BenchmarkOutput {
  env: EnvironmentInfo
  timestamp: string
  config: BenchmarkConfig
  engines: Record<string, string>
  tiers: TierResults
  serialization?: Record<string, SerializationResult>
  mutations?: Record<string, MutationResult>
  quality?: Record<string, QualityResult>
}

export interface TimeSeriesPoint {
  checkpoint: number
  label?: string
  insertThroughput?: number
  searchMedianMs?: number
  searchP95Ms?: number
  memoryBytes?: number
  partitionCount?: number
}

export interface ComparisonRow {
  label: string
  metrics: Record<string, number | string>
}

export interface ScenarioResult {
  name: string
  description: string
  config: Record<string, unknown>
  timeSeries?: TimeSeriesPoint[]
  comparisons?: ComparisonRow[]
  durationMs: number
}

export interface ScenarioOutput {
  env: EnvironmentInfo
  timestamp: string
  scenarios: ScenarioResult[]
}
