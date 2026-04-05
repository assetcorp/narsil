import { createNarsil } from '@delali/narsil'
import { downloadAndCacheWiki, loadWikiArticles, wikiToBenchDocuments } from './data-wiki'
import { STOP_WORD_SET } from './stopwords'

const SCALE = 100_000
const QUERY_COUNT = 50

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
  console.log('Insert complete')

  const queries = ['united states', 'computer science', 'world war', 'new york', 'population growth']

  console.log('\n--- Unfiltered search (baseline) ---')
  for (let warmup = 0; warmup < 5; warmup++) {
    await instance.query('bench', { term: queries[0] })
  }
  const unfilteredTimes: number[] = []
  for (const q of queries) {
    const start = performance.now()
    for (let i = 0; i < QUERY_COUNT; i++) {
      await instance.query('bench', { term: q })
    }
    const elapsed = (performance.now() - start) / QUERY_COUNT
    unfilteredTimes.push(elapsed)
    console.log(`  "${q}": ${elapsed.toFixed(3)}ms avg`)
  }
  const unfilteredAvg = unfilteredTimes.reduce((a, b) => a + b, 0) / unfilteredTimes.length
  console.log(`  Average: ${unfilteredAvg.toFixed(3)}ms`)

  console.log('\n--- Filtered search (category eq + score gte) ---')
  for (let warmup = 0; warmup < 5; warmup++) {
    await instance.query('bench', {
      term: queries[0],
      filters: { fields: { category: { eq: 'engineering' }, score: { gte: 50 } } },
    })
  }
  const filteredTimes: number[] = []
  for (const q of queries) {
    const start = performance.now()
    for (let i = 0; i < QUERY_COUNT; i++) {
      await instance.query('bench', {
        term: q,
        filters: { fields: { category: { eq: 'engineering' }, score: { gte: 50 } } },
      })
    }
    const elapsed = (performance.now() - start) / QUERY_COUNT
    filteredTimes.push(elapsed)
    console.log(`  "${q}": ${elapsed.toFixed(3)}ms avg`)
  }
  const filteredAvg = filteredTimes.reduce((a, b) => a + b, 0) / filteredTimes.length
  console.log(`  Average: ${filteredAvg.toFixed(3)}ms`)

  console.log('\n--- Filter evaluation only (no text search) ---')
  const filterOnlyTimes: number[] = []
  for (let run = 0; run < 5; run++) {
    const start = performance.now()
    for (let i = 0; i < QUERY_COUNT; i++) {
      await instance.query('bench', {
        term: queries[run % queries.length],
        filters: { fields: { category: { eq: 'engineering' }, score: { gte: 50 } } },
      })
    }
    const elapsed = (performance.now() - start) / QUERY_COUNT
    filterOnlyTimes.push(elapsed)
  }
  const filterOnlyAvg = filterOnlyTimes.reduce((a, b) => a + b, 0) / filterOnlyTimes.length

  console.log('\n--- Summary ---')
  console.log(`Unfiltered search avg: ${unfilteredAvg.toFixed(3)}ms`)
  console.log(`Filtered search avg:   ${filteredAvg.toFixed(3)}ms`)
  console.log(`Filter overhead:       ${(filteredAvg - unfilteredAvg).toFixed(3)}ms`)
  console.log(`Filter overhead ratio: ${(filteredAvg / unfilteredAvg).toFixed(1)}x`)

  await instance.shutdown()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
