import { createNarsil } from '@delali/narsil'
import { generateWikiFilteredQueries, generateWikiQueries, loadWikiArticles, wikiToBenchDocuments } from './data-wiki'
import { median } from './stats'
import { STOP_WORD_SET } from './stopwords'

const SCALE = 100_000
const SEED = 42

async function main() {
  const articles = await loadWikiArticles(SCALE, { noDownload: false })
  console.log(`Loaded ${articles.length} articles`)

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
    stopWords: STOP_WORD_SET,
  })

  const docs = wikiToBenchDocuments(articles.slice(0, SCALE))
  const insertDocs = docs.map(({ id, ...rest }) => rest)
  console.log(`Inserting ${insertDocs.length} documents...`)
  await instance.insertBatch('bench', insertDocs, { skipClone: true })
  console.log('Insert complete\n')

  const queries = generateWikiQueries(articles.slice(0, SCALE), 100, SEED + 1)
  const filteredQueries = generateWikiFilteredQueries(articles.slice(0, SCALE), 100, SEED + 3)

  for (let warmup = 0; warmup < 10; warmup++) {
    await instance.query('bench', { term: queries[warmup] })
  }

  console.log('--- Unfiltered (default limit=10, maxResults=11) ---')
  const unfilteredTimes: number[] = []
  for (const q of queries) {
    const start = performance.now()
    await instance.query('bench', { term: q })
    unfilteredTimes.push(performance.now() - start)
  }
  console.log(`  Median: ${median(unfilteredTimes).toFixed(3)}ms`)

  console.log('\n--- Unfiltered with limit=1000 (forces full scoring) ---')
  const unfilteredFullTimes: number[] = []
  for (const q of queries) {
    const start = performance.now()
    await instance.query('bench', { term: q, limit: 1000 })
    unfilteredFullTimes.push(performance.now() - start)
  }
  console.log(`  Median: ${median(unfilteredFullTimes).toFixed(3)}ms`)

  console.log('\n--- Filtered (category eq + score gte) ---')
  const filteredTimes: number[] = []
  for (const q of filteredQueries) {
    const start = performance.now()
    await instance.query('bench', {
      term: q,
      filters: { fields: { category: { eq: 'engineering' }, score: { gte: 50 } } },
    })
    filteredTimes.push(performance.now() - start)
  }
  console.log(`  Median: ${median(filteredTimes).toFixed(3)}ms`)

  console.log('\n--- Filtered with explicit limit=10 (still has hasPostFilters=true) ---')
  const filteredLimitTimes: number[] = []
  for (const q of filteredQueries) {
    const start = performance.now()
    await instance.query('bench', {
      term: q,
      limit: 10,
      filters: { fields: { category: { eq: 'engineering' }, score: { gte: 50 } } },
    })
    filteredLimitTimes.push(performance.now() - start)
  }
  console.log(`  Median: ${median(filteredLimitTimes).toFixed(3)}ms`)

  console.log('\n--- Summary ---')
  console.log(`Unfiltered (limit 10):   ${median(unfilteredTimes).toFixed(3)}ms`)
  console.log(`Unfiltered (limit 1000): ${median(unfilteredFullTimes).toFixed(3)}ms`)
  console.log(`Filtered:                ${median(filteredTimes).toFixed(3)}ms`)
  console.log(`Filtered (limit 10):     ${median(filteredLimitTimes).toFixed(3)}ms`)

  await instance.shutdown()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
