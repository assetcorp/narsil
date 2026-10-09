import { bench, describe } from 'vitest'
import { vectorOf } from './dbpedia/dataset'
import { readGraphBuildSample } from './dbpedia/graph-build-sample'
import {
  awaitBackgroundGraph,
  createSingleThreadEngine,
  dbpediaIndexConfig,
  graphBuildSamplePath,
  indexDirectory,
  TEXT_FIELD,
  VECTOR_FIELD,
  type VectorPrecision,
  withRepeatableGraphLevels,
} from './dbpedia/indexes'

const sample = readGraphBuildSample(graphBuildSamplePath(indexDirectory()))
const documents = sample.ids.map((id, row) => ({
  id,
  [TEXT_FIELD]: sample.texts[row],
  [VECTOR_FIELD]: vectorOf(sample, row),
}))

async function buildGraph(precision: VectorPrecision): Promise<void> {
  const narsil = await createSingleThreadEngine()
  try {
    await narsil.createIndex(precision, dbpediaIndexConfig(precision, documents.length))
    await withRepeatableGraphLevels(async () => {
      await narsil.insertBatch(precision, documents)
      await awaitBackgroundGraph(narsil, precision)
    })
  } finally {
    await narsil.shutdown()
  }
}

describe('build the vector graph for the first 1,000 DBpedia documents, through the C search core', () => {
  bench('full precision', () => buildGraph('full-precision'))

  bench('4-bit quantisation', () => buildGraph('osq4'))
})
