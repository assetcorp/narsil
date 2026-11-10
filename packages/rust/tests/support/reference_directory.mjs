import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, directory, index, idsJson, wordsJson] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const SEARCH_LIMIT = 10_000

const narsil = await createNarsil({ durability: { directory }, workers: { enabled: false } })
try {
  const held = await narsil.getMultiple(index, JSON.parse(idsJson))
  const documents = Object.fromEntries([...held.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const count = await narsil.countDocuments(index)
  const searches = {}
  for (const word of JSON.parse(wordsJson)) {
    const found = await narsil.query(index, { term: word, limit: SEARCH_LIMIT })
    searches[word] = found.hits.map(hit => hit.id).sort()
  }
  process.stdout.write(JSON.stringify({ documents, count, searches }))
} finally {
  await narsil.shutdown()
}
