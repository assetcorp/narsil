import { createNarsil, type Narsil } from '@delali/narsil'
import { generateDocuments, generateVectorDocuments } from '../data'
import { fmt, tryGc } from '../stats'
import type { ComparisonRow, ScenarioResult } from '../types'

const SCALES = [1_000, 10_000, 50_000]
const VECTOR_DIMENSION = 384
const SEED = 42

async function settleHeap(): Promise<number> {
  tryGc()
  tryGc()
  await new Promise(resolve => setTimeout(resolve, 100))
  return process.memoryUsage().heapUsed
}

export async function runMemoryAccuracy(): Promise<ScenarioResult> {
  const start = performance.now()
  const comparisons: ComparisonRow[] = []

  if (typeof globalThis.gc !== 'function') {
    console.log('  warning: --expose-gc not set, memory measurements will be approximate')
  }

  for (const scale of SCALES) {
    let instance: Narsil | undefined
    try {
      const baselineHeap = await settleHeap()

      instance = await createNarsil()
      await instance.createIndex('bench', {
        schema: {
          title: 'string' as const,
          body: 'string' as const,
          score: 'number' as const,
          category: 'enum' as const,
        },
        language: 'english',
        trackPositions: false,
      })

      const docs = generateDocuments(scale, SEED)
      const insertDocs = docs.map(({ id, ...rest }) => rest)
      await instance.insertBatch('bench', insertDocs, { skipClone: true })

      const afterHeap = await settleHeap()
      const heapDelta = Math.max(0, afterHeap - baselineHeap)
      const estimatedBytes = instance.getStats('bench').memoryBytes
      const ratio = estimatedBytes > 0 ? (estimatedBytes / heapDelta).toFixed(2) : 'n/a'

      console.log(
        `  text ${fmt(scale)}: heap delta ${fmt(heapDelta)} bytes, ` +
          `estimated ${fmt(estimatedBytes)} bytes, ` +
          `ratio ${ratio}`,
      )

      comparisons.push({
        label: `text-${fmt(scale)}`,
        metrics: {
          scale,
          variant: 'text-only',
          heapDeltaBytes: heapDelta,
          estimatedBytes,
          ratio: estimatedBytes > 0 ? Number(ratio) : 0,
        },
      })

      await instance.shutdown()
      instance = undefined
    } finally {
      if (instance) await instance.shutdown()
    }

    let vecInstance: Narsil | undefined
    try {
      const baselineHeap = await settleHeap()

      vecInstance = await createNarsil()
      await vecInstance.createIndex('bench', {
        schema: {
          title: 'string' as const,
          embedding: `vector[${VECTOR_DIMENSION}]` as const,
        },
        language: 'english',
        trackPositions: false,
      })

      const vecDocs = generateVectorDocuments(scale, VECTOR_DIMENSION, SEED)
      const insertDocs = vecDocs.map(({ id, ...rest }) => rest)
      await vecInstance.insertBatch('bench', insertDocs, { skipClone: true })

      const afterHeap = await settleHeap()
      const heapDelta = Math.max(0, afterHeap - baselineHeap)
      const estimatedBytes = vecInstance.getStats('bench').memoryBytes
      const ratio = estimatedBytes > 0 ? (estimatedBytes / heapDelta).toFixed(2) : 'n/a'

      console.log(
        `  vector ${fmt(scale)}: heap delta ${fmt(heapDelta)} bytes, ` +
          `estimated ${fmt(estimatedBytes)} bytes, ` +
          `ratio ${ratio}`,
      )

      comparisons.push({
        label: `vector-${fmt(scale)}`,
        metrics: {
          scale,
          variant: 'vector-384d',
          heapDeltaBytes: heapDelta,
          estimatedBytes,
          ratio: estimatedBytes > 0 ? Number(ratio) : 0,
        },
      })

      await vecInstance.shutdown()
      vecInstance = undefined
    } finally {
      if (vecInstance) await vecInstance.shutdown()
    }
  }

  return {
    name: 'memory-accuracy',
    description: 'Validates getStats().memoryBytes against actual heap delta',
    config: { scales: SCALES, vectorDimension: VECTOR_DIMENSION },
    comparisons,
    durationMs: performance.now() - start,
  }
}
