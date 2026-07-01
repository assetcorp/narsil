import { createNarsil, type Narsil } from '@delali/narsil'
import { loadWikiArticles, wikiToBenchDocuments } from './data-wiki'
import { fmt } from './stats'

const SCALES = [1_000, 5_000, 10_000]

async function profileInsert(instance: Narsil, docs: Array<Record<string, unknown>>, label: string): Promise<void> {
  const BATCH_SIZE = 500
  const batches = Math.ceil(docs.length / BATCH_SIZE)
  let totalMs = 0
  const batchTimes: number[] = []

  for (let b = 0; b < batches; b++) {
    const batch = docs.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE)
    const start = performance.now()
    await instance.insertBatch('bench', batch, { skipClone: true })
    const elapsed = performance.now() - start
    totalMs += elapsed
    batchTimes.push(elapsed)
  }

  const docsPerSec = Math.round(docs.length / (totalMs / 1000))
  const avgBatchMs = totalMs / batches
  const firstBatch = batchTimes[0]
  const lastBatch = batchTimes[batchTimes.length - 1]
  const slowdown = lastBatch / firstBatch

  console.log(`  ${label}: ${fmt(docsPerSec)} docs/sec (${totalMs.toFixed(0)}ms total)`)
  console.log(
    `    avg batch: ${avgBatchMs.toFixed(1)}ms, first: ${firstBatch.toFixed(1)}ms, last: ${lastBatch.toFixed(1)}ms`,
  )
  console.log(`    slowdown factor (last/first): ${slowdown.toFixed(2)}x`)
}

async function main() {
  const articles = await loadWikiArticles(10_000)
  console.log('\nInsert Profile (Wikipedia data)\n')

  for (const scale of SCALES) {
    if (scale > articles.length) continue
    const docs = wikiToBenchDocuments(articles.slice(0, scale))
    const insertDocs = docs.map(({ id, ...rest }) => rest)

    console.log(`\n--- ${fmt(scale)} documents ---`)

    const instance = await createNarsil()
    await instance.createIndex('bench', {
      schema: { title: 'string' as const, body: 'string' as const },
      language: 'english',
      trackPositions: false,
    })

    await profileInsert(instance, insertDocs, 'text-only')
    await instance.shutdown()

    const instanceFull = await createNarsil()
    await instanceFull.createIndex('bench', {
      schema: {
        title: 'string' as const,
        body: 'string' as const,
        score: 'number' as const,
        category: 'enum' as const,
      },
      language: 'english',
      trackPositions: false,
    })

    const fullDocs = docs.map(({ id, ...rest }) => rest)
    await profileInsert(instanceFull, fullDocs, 'full-schema')
    await instanceFull.shutdown()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
