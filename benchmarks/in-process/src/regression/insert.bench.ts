import { bench, describe } from 'vitest'
import { createNarsilEngine, INSERT_DOCUMENT_COUNT, loadFiqaWorkload } from './workload'

const { docs } = await loadFiqaWorkload(INSERT_DOCUMENT_COUNT)

describe('insert FiQA documents into a fresh index, as the published embedded table does', () => {
  bench('insertBatch 1,000 documents with two text fields', async () => {
    const engine = createNarsilEngine('text-only')
    await engine.create()
    await engine.insert(docs)
    await engine.teardown()
  })
})
