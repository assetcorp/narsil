import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createNarsil } from '../../../ts/src/narsil'
import type { Narsil } from '../../../ts/src/types/engine'
import { NOTE_SCHEMA, noteDocuments, PRODUCT_SCHEMA, productDocuments } from './documents'

export const PRODUCTS_INDEX = 'products'
export const NOTES_INDEX = 'notes'
export const READING_QUANTIZATIONS = ['osq8', 'osq2', 'osq1'] as const
export type ReadingQuantization = (typeof READING_QUANTIZATIONS)[number]
const READING_COUNT = 20
const PRODUCT_COUNT = 48
const NOTE_COUNT = 140
const PROMOTION_THRESHOLD = 16
const GRAPH_SETTLE_DEADLINE_MS = 120_000
const GRAPH_SETTLE_POLL_MS = 20
const NEVER_CHECKPOINT_ON_ITS_OWN_MS = 86_400_000
const NEVER_CHECKPOINT_ON_MUTATIONS = 1_000_000_000

export function readingsIndexOf(quantization: ReadingQuantization): string {
  return `readings-${quantization}`
}

export interface ScenarioOutput {
  checkpoint: string
  archive: Uint8Array
  exported: Uint8Array
}

async function waitForGraphs(narsil: Narsil, indexName: string, emptyBuffer: boolean): Promise<void> {
  const deadline = Date.now() + GRAPH_SETTLE_DEADLINE_MS
  while (
    narsil
      .vectorMaintenanceStatus(indexName)
      .some(field => field.building || field.graphCount === 0 || (emptyBuffer && field.bufferSize > 0))
  ) {
    if (Date.now() > deadline) throw new Error(`${indexName} was still building its graph at the deadline`)
    await delay(GRAPH_SETTLE_POLL_MS)
  }
}

async function bytesOfStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

async function fillProducts(narsil: Narsil): Promise<void> {
  await narsil.createIndex(PRODUCTS_INDEX, {
    schema: PRODUCT_SCHEMA,
    language: 'english',
    trackPositions: true,
    surfaceForms: true,
    required: ['title'],
    bm25: { k1: 1.4, b: 0.7 },
    vectorPromotion: {
      threshold: PROMOTION_THRESHOLD,
      quantization: 'osq4',
      storage: 'memory',
      hnswConfig: { m: 8, efConstruction: 64, metric: 'cosine' },
    },
  })
  const documents = productDocuments(PRODUCT_COUNT)
  const first = await narsil.insertBatch(PRODUCTS_INDEX, documents.slice(0, PRODUCT_COUNT - 8))
  if (first.failed.length > 0) throw new Error(`the reference refused ${first.failed.length} products`)
  await waitForGraphs(narsil, PRODUCTS_INDEX, true)
  await narsil.checkpoint(PRODUCTS_INDEX)
  const second = await narsil.insertBatch(PRODUCTS_INDEX, documents.slice(PRODUCT_COUNT - 8, PRODUCT_COUNT - 4))
  if (second.failed.length > 0) throw new Error(`the reference refused ${second.failed.length} products`)
  await narsil.remove(PRODUCTS_INDEX, 'product-001')
  await waitForGraphs(narsil, PRODUCTS_INDEX, false)
  await narsil.checkpoint(PRODUCTS_INDEX)
  for (const document of documents.slice(PRODUCT_COUNT - 4)) await narsil.insert(PRODUCTS_INDEX, document)
  await narsil.remove(PRODUCTS_INDEX, 'product-002')
}

async function fillNotes(narsil: Narsil): Promise<void> {
  await narsil.createIndex(NOTES_INDEX, {
    schema: NOTE_SCHEMA,
    language: 'english',
    textStorage: 'disk',
    vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization: 'none', storage: 'disk' },
  })
  const result = await narsil.insertBatch(NOTES_INDEX, noteDocuments(NOTE_COUNT))
  if (result.failed.length > 0) throw new Error(`the reference refused ${result.failed.length} notes`)
  await waitForGraphs(narsil, NOTES_INDEX, true)
  await narsil.checkpoint(NOTES_INDEX)
}

async function fillReadings(narsil: Narsil, quantization: ReadingQuantization): Promise<void> {
  const indexName = readingsIndexOf(quantization)
  await narsil.createIndex(indexName, {
    schema: NOTE_SCHEMA,
    language: 'english',
    vectorPromotion: { threshold: PROMOTION_THRESHOLD, quantization, storage: 'memory' },
  })
  const result = await narsil.insertBatch(indexName, noteDocuments(READING_COUNT))
  if (result.failed.length > 0) throw new Error(`the reference refused ${result.failed.length} readings`)
  await waitForGraphs(narsil, indexName, true)
  await narsil.checkpoint(indexName)
}

export async function writeScenario(workDirectory: string): Promise<ScenarioOutput> {
  const live = join(workDirectory, 'live')
  const checkpoint = join(workDirectory, 'checkpoint')
  await mkdir(live, { recursive: true })
  const narsil = await createNarsil({
    workers: { enabled: false },
    durability: {
      directory: live,
      mode: 'sync',
      checkpointIntervalMs: NEVER_CHECKPOINT_ON_ITS_OWN_MS,
      checkpointMutationThreshold: NEVER_CHECKPOINT_ON_MUTATIONS,
    },
  })
  try {
    await fillProducts(narsil)
    await fillNotes(narsil)
    for (const quantization of READING_QUANTIZATIONS) await fillReadings(narsil, quantization)
    await cp(live, checkpoint, { recursive: true })
    const archive = await bytesOfStream(await narsil.snapshot(PRODUCTS_INDEX))
    const exported = await bytesOfStream(await narsil.exportDocuments(PRODUCTS_INDEX))
    return { checkpoint, archive, exported }
  } finally {
    await narsil.shutdown()
  }
}
