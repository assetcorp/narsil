import { afterAll, bench, describe } from 'vitest'
import { createPopulatedEngine, loadFiqaWorkload, SEARCH_DOCUMENT_COUNT } from './workload'

const workload = await loadFiqaWorkload(SEARCH_DOCUMENT_COUNT)
const engine = await createPopulatedEngine('full-schema', workload.docs)
const filteredSearch = engine.searchWithFilter
if (!filteredSearch) throw new Error('the Narsil adapter lost the filtered search that the published suite measures')

describe('search 10,000 FiQA documents with the 100 filtered queries of the published run', () => {
  afterAll(async () => {
    await engine.teardown()
  })

  bench('keyword queries filtered on an enum and a number range', async () => {
    for (const query of workload.filteredQueries) await filteredSearch.call(engine, query)
  })
})
