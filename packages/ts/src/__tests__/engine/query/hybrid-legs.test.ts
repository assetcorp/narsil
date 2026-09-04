import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEngineCore, type EngineCore } from '../../../engine/core'
import { createEngineIndex } from '../../../engine/index-lifecycle'
import { shutdownEngine } from '../../../engine/lifecycle'
import { insertDocument } from '../../../engine/mutations'
import type { QueryContext } from '../../../engine/query'
import { executeHybridSearch } from '../../../engine/query/vector'
import type { IndexConfig } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'

const INDEX_NAME = 'docs'

const indexConfig: IndexConfig = {
  schema: { title: 'string', embedding: 'vector[4]' },
  language: 'english',
}

const hybridParams: QueryParams = {
  mode: 'hybrid',
  term: 'engine',
  vector: { field: 'embedding', value: [1, 0, 0, 0] },
  hybrid: { strategy: 'rrf', k: 60 },
  limit: 10,
}

describe('hybrid query legs', () => {
  let core: EngineCore

  beforeEach(async () => {
    core = createEngineCore({ workers: { enabled: false } })
    await createEngineIndex(core, undefined, INDEX_NAME, indexConfig)
    await insertDocument(core.mutationCtx, INDEX_NAME, { title: 'engine engine engine', embedding: [0, 1, 0, 0] }, 'A')
    await insertDocument(core.mutationCtx, INDEX_NAME, { title: 'engine', embedding: [1, 0, 0, 0] }, 'B')
    await insertDocument(core.mutationCtx, INDEX_NAME, { title: 'unrelated words', embedding: [1, 0.3, 0, 0] }, 'C')
  })

  afterEach(async () => {
    await shutdownEngine(core)
  })

  it('has the vector leg in flight while the text leg runs, and fuses the same results', async () => {
    const manager = core.requireManager(INDEX_NAME)
    const entry = core.requireIndex(INDEX_NAME)
    const vecIndex = manager.getVectorIndexes().get('embedding')
    if (vecIndex === undefined) throw new Error('the embedding field has no vector index')

    let releaseVector = (): void => undefined
    const vectorGate = new Promise<void>(resolve => {
      releaseVector = resolve
    })
    let vectorStarted = false
    let vectorFinished = false
    const originalSearch = vecIndex.searchParallel
    vi.spyOn(vecIndex, 'searchParallel').mockImplementation(async (query, k, options) => {
      vectorStarted = true
      await vectorGate
      const results = await originalSearch(query, k, options)
      vectorFinished = true
      return results
    })

    let vectorInFlightDuringText = false
    const context: QueryContext = {
      manager,
      language: entry.language,
      config: entry.config,
      indexName: INDEX_NAME,
      cursorBinding: '',
      workerSearch: async () => {
        vectorInFlightDuringText = vectorStarted && !vectorFinished
        releaseVector()
        return null
      },
    }

    const result = await executeHybridSearch(hybridParams, context, 10, 0)

    expect(vectorInFlightDuringText).toBe(true)
    expect(result.scored.map(doc => doc.docId)).toEqual(['B', 'A', 'C'])
  })
})
