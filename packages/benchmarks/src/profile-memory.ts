import { resolve } from 'node:path'
import v8 from 'node:v8'
import { createNarsil } from '@delali/narsil'
import { generateDocuments } from './data'
import { writeJsonAtomicSync } from './runner/atomic-write'
import { artifactFilename, prepareRunArtifact } from './runner/run-paths'
import { tryGc } from './stats'

const DOC_COUNT = 100_000
const SEED = 42

async function main() {
  const { runDir, artifactPath } = prepareRunArtifact('memoryProfile')
  console.log(`Run folder: ${runDir}`)
  console.log(`Memory Profile: ${DOC_COUNT.toLocaleString()} documents\n`)

  tryGc()
  tryGc()
  await new Promise(r => setTimeout(r, 200))
  const baselineHeap = process.memoryUsage().heapUsed

  const narsil = await createNarsil()
  await narsil.createIndex('bench', {
    schema: {
      title: 'string' as const,
      body: 'string' as const,
      score: 'number' as const,
      category: 'enum' as const,
    },
    language: 'english',
    trackPositions: false,
  })

  console.log('generating documents...')
  const docs = generateDocuments(DOC_COUNT, SEED)

  console.log('inserting documents...')
  const insertStart = performance.now()
  await narsil.insertBatch(
    'bench',
    docs.map(({ id, ...rest }) => rest),
    { skipClone: true },
  )
  const insertMs = performance.now() - insertStart
  const insertDocsPerSec = Math.round(DOC_COUNT / (insertMs / 1000))
  console.log(`insert: ${(insertMs / 1000).toFixed(1)}s (${insertDocsPerSec.toLocaleString()} docs/sec)\n`)

  tryGc()
  tryGc()
  await new Promise(r => setTimeout(r, 200))
  const afterHeap = process.memoryUsage().heapUsed
  const heapDelta = afterHeap - baselineHeap

  const stats = narsil.getStats('bench')
  const memUsage = process.memoryUsage()

  console.log('--- Memory Breakdown ---')
  console.log(`heap used: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB`)
  console.log(`heap total: ${(memUsage.heapTotal / 1024 / 1024).toFixed(1)}MB`)
  console.log(`external: ${(memUsage.external / 1024 / 1024).toFixed(1)}MB`)
  console.log(`rss: ${(memUsage.rss / 1024 / 1024).toFixed(1)}MB`)
  console.log(`heap delta (index only): ${(heapDelta / 1024 / 1024).toFixed(1)}MB`)
  console.log(`narsil estimated: ${(stats.estimatedMemoryBytes / 1024 / 1024).toFixed(1)}MB`)
  console.log(`estimation ratio: ${(stats.estimatedMemoryBytes / heapDelta).toFixed(2)}x`)
  console.log(`per-doc actual: ${Math.round(heapDelta / DOC_COUNT)} bytes`)
  console.log(`per-doc estimated: ${Math.round(stats.estimatedMemoryBytes / DOC_COUNT)} bytes`)

  console.log('\ntaking heap snapshot...')
  const snapshotTarget = resolve(runDir, artifactFilename('heapSnapshot'))
  const snapshotPath = v8.writeHeapSnapshot(snapshotTarget)
  console.log(`snapshot saved to: ${snapshotPath}`)
  console.log('open in Chrome DevTools (Memory tab) to analyze retained sizes')

  writeJsonAtomicSync(artifactPath, {
    docCount: DOC_COUNT,
    seed: SEED,
    timestamp: new Date().toISOString(),
    insert: { totalMs: insertMs, docsPerSec: insertDocsPerSec },
    memory: {
      heapUsedBytes: memUsage.heapUsed,
      heapTotalBytes: memUsage.heapTotal,
      externalBytes: memUsage.external,
      rssBytes: memUsage.rss,
      heapDeltaBytes: heapDelta,
      narsilEstimatedBytes: stats.estimatedMemoryBytes,
      estimationRatio: stats.estimatedMemoryBytes / heapDelta,
      perDocActualBytes: Math.round(heapDelta / DOC_COUNT),
      perDocEstimatedBytes: Math.round(stats.estimatedMemoryBytes / DOC_COUNT),
    },
    heapSnapshotPath: snapshotPath,
  })

  await narsil.shutdown()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
