export interface BenchDocument {
  id: string
  title: string
  body: string
  score: number
  category: string
}

export interface SearchEngine {
  name: string
  create(): Promise<void>
  insert(documents: BenchDocument[]): Promise<void>
  search(query: string): Promise<number>
  searchTermMatchAll?(query: string): Promise<number>
  teardown(): Promise<void>
}

export interface ScaleResult {
  insertMedianMs: number
  insertDocsPerSec: number
  searchMedianMs: number
  searchP95Ms: number
  searchAllTermsMedianMs?: number
  searchAllTermsP95Ms?: number
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
  insertIterations: number
  warmupIterations: number
  searchQueryCount: number
  seed: number
}

export interface BenchmarkOutput {
  env: EnvironmentInfo
  timestamp: string
  config: BenchmarkConfig
  engines: Record<string, string>
  results: Record<string, Record<number, ScaleResult>>
}
