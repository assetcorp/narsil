import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createNarsil, type IndexConfig, type Narsil, type VectorMaintenanceResult } from '@delali/narsil'
import { createRng } from '../../data'
import { DBPEDIA_DIMENSIONS } from './dataset'

export const VECTOR_FIELD = 'embedding'
export const TEXT_FIELD = 'text'
export const PUBLISHED_EF_SEARCH = 128
export const PUBLISHED_RRF_K = 60
export const RESULT_COUNT = 10
export const VECTOR_PRECISIONS = ['full-precision', 'osq4'] as const
export const INDEX_DIRECTORY_VARIABLE = 'BENCH_DBPEDIA_INDEX_DIR'

export type VectorPrecision = (typeof VECTOR_PRECISIONS)[number]

const QUANTIZATION_OF: Record<VectorPrecision, 'none' | 'osq4'> = { 'full-precision': 'none', osq4: 'osq4' }
const PUBLISHED_HNSW = { m: 16, efConstruction: 200, metric: 'cosine' } as const
const PUBLISHED_BM25 = { k1: 0.9, b: 0.4 }
const GRAPH_LEVEL_SEED = 42

export function dbpediaIndexConfig(precision: VectorPrecision, documentCount: number): IndexConfig {
  return {
    schema: { [TEXT_FIELD]: 'string', [VECTOR_FIELD]: `vector[${DBPEDIA_DIMENSIONS}]` },
    bm25: PUBLISHED_BM25,
    vectorPromotion: {
      threshold: documentCount,
      quantization: QUANTIZATION_OF[precision],
      hnswConfig: PUBLISHED_HNSW,
    },
  }
}

export function createSingleThreadEngine(): Promise<Narsil> {
  return createNarsil({ workers: { enabled: false } })
}

function graphComplete(fields: VectorMaintenanceResult[]): boolean {
  return fields.length > 0 && fields.every(field => field.graphCount === 1 && field.bufferSize === 0 && !field.building)
}

export async function withRepeatableGraphLevels<T>(work: () => Promise<T>): Promise<T> {
  const random = Math.random
  Math.random = createRng(GRAPH_LEVEL_SEED)
  try {
    return await work()
  } finally {
    Math.random = random
  }
}

export async function awaitBackgroundGraph(narsil: Narsil, indexName: string): Promise<void> {
  await delay(0)
  await narsil.optimizeVectors(indexName, VECTOR_FIELD)
  if (!graphComplete(narsil.vectorMaintenanceStatus(indexName))) {
    throw new Error(`Narsil left the ${indexName} vector graph unfinished`)
  }
}

export function indexDirectory(): string {
  const directory = process.env[INDEX_DIRECTORY_VARIABLE]
  if (directory === undefined || directory.length === 0) {
    throw new Error(`${INDEX_DIRECTORY_VARIABLE} names no directory; build the indexes with pnpm dbpedia:build`)
  }
  return directory
}

export function snapshotPath(directory: string, precision: VectorPrecision): string {
  return resolve(directory, `dbpedia-100k-${precision}.nrsl`)
}

export async function restoreIndex(narsil: Narsil, directory: string, precision: VectorPrecision): Promise<void> {
  await narsil.restore(precision, readFileSync(snapshotPath(directory, precision)))
  if (!graphComplete(narsil.vectorMaintenanceStatus(precision))) {
    throw new Error(`the ${precision} snapshot holds no finished vector graph; rebuild it with pnpm dbpedia:build`)
  }
}

export function graphBuildSamplePath(directory: string): string {
  return resolve(directory, 'graph-build-sample.json')
}
