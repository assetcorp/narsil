import { createNarsil } from '@delali/narsil'
import { generateDocuments } from './data'

const SCALE = 50_000
const SEED = 42

async function main() {
  const docs = generateDocuments(SCALE, SEED)
  const instance = await createNarsil()
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

  const stripped = docs.map(({ id, ...doc }) => doc)

  console.log(`Inserting ${SCALE} documents...`)
  const start = performance.now()
  await instance.insertBatch('bench', stripped)
  const elapsed = performance.now() - start
  console.log(`Done in ${elapsed.toFixed(0)}ms (${Math.round(SCALE / (elapsed / 1000))} docs/sec)`)

  await instance.shutdown()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
