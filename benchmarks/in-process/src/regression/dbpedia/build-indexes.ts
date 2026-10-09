import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Narsil } from '@delali/narsil'
import type { VectorRows } from './dataset'
import { DBPEDIA_DOCUMENTS, dbpediaDirectory, loadDocuments, vectorOf } from './dataset'
import { encodeGraphBuildSample } from './graph-build-sample'
import {
  awaitBackgroundGraph,
  createSingleThreadEngine,
  dbpediaIndexConfig,
  graphBuildSamplePath,
  indexDirectory,
  snapshotPath,
  TEXT_FIELD,
  VECTOR_FIELD,
  VECTOR_PRECISIONS,
  type VectorPrecision,
  withRepeatableGraphLevels,
} from './indexes'

const INSERT_CHUNK = 1_000

async function insertAll(narsil: Narsil, documents: VectorRows, precision: VectorPrecision): Promise<void> {
  for (let start = 0; start < documents.ids.length; start += INSERT_CHUNK) {
    const end = Math.min(start + INSERT_CHUNK, documents.ids.length)
    const chunk = []
    for (let row = start; row < end; row++) {
      chunk.push({
        id: documents.ids[row],
        [TEXT_FIELD]: documents.texts[row],
        [VECTOR_FIELD]: vectorOf(documents, row),
      })
    }
    const result = await narsil.insertBatch(precision, chunk)
    if (result.failed.length > 0) {
      throw new Error(
        `Narsil refused ${result.failed.length} documents; the first: ${JSON.stringify(result.failed[0])}`,
      )
    }
  }
}

async function buildIndex(documents: VectorRows, precision: VectorPrecision, directory: string): Promise<void> {
  const started = performance.now()
  const narsil = await createSingleThreadEngine()
  try {
    await narsil.createIndex(precision, dbpediaIndexConfig(precision, documents.ids.length))
    await withRepeatableGraphLevels(async () => {
      await insertAll(narsil, documents, precision)
      await awaitBackgroundGraph(narsil, precision)
    })
    writeFileSync(snapshotPath(directory, precision), await narsil.snapshot(precision))
  } finally {
    await narsil.shutdown()
  }
  console.log(
    `built ${precision} over ${documents.ids.length} documents in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  )
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { documents: { type: 'string' } } })
  const limit = values.documents === undefined ? DBPEDIA_DOCUMENTS : Number(values.documents)
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`--documents takes a positive whole number`)
  const directory = resolve(indexDirectory())
  mkdirSync(directory, { recursive: true })

  const documents = loadDocuments(dbpediaDirectory(), limit)
  console.log(`read ${documents.ids.length} documents`)
  writeFileSync(graphBuildSamplePath(directory), encodeGraphBuildSample(documents))
  for (const precision of VECTOR_PRECISIONS) await buildIndex(documents, precision, directory)
}

await main()
