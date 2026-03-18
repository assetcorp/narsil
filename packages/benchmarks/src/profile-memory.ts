import v8 from 'node:v8'
import { createNarsil } from '@delali/narsil'
import { generateDocuments } from './data'
import { tryGc } from './stats'

const DOC_COUNT = 100_000
const SEED = 42

async function main() {
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
  console.log(
    `insert: ${(insertMs / 1000).toFixed(1)}s (${Math.round(DOC_COUNT / (insertMs / 1000)).toLocaleString()} docs/sec)\n`,
  )

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
  console.log(`narsil estimated: ${(stats.memoryBytes / 1024 / 1024).toFixed(1)}MB`)
  console.log(`estimation ratio: ${(stats.memoryBytes / heapDelta).toFixed(2)}x`)
  console.log(`per-doc actual: ${Math.round(heapDelta / DOC_COUNT)} bytes`)
  console.log(`per-doc estimated: ${Math.round(stats.memoryBytes / DOC_COUNT)} bytes`)

  console.log('\ntaking heap snapshot...')
  const snapshotPath = v8.writeHeapSnapshot()
  console.log(`snapshot saved to: ${snapshotPath}`)
  console.log('open in Chrome DevTools (Memory tab) to analyze retained sizes')

  await narsil.shutdown()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
