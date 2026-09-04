import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../distribution/cluster-node/local-engine'
import { MAX_SUGGEST_LIMIT, MAX_SUGGEST_SCATTER_LIMIT } from '../../engine/constants'

const PREFIX = 'run'
const TERM_TOTAL = 200

function completionDocuments(): Array<{ title: string }> {
  const documents: Array<{ title: string }> = []
  for (let index = 0; index < TERM_TOTAL; index += 1) {
    documents.push({ title: `${PREFIX}${index.toString().padStart(4, '0')}` })
  }
  return documents
}

describe('partition-scoped suggest limit', () => {
  let engine: Awaited<ReturnType<typeof createClusterLocalEngine>>

  beforeEach(async () => {
    engine = await createClusterLocalEngine()
    await engine.createIndex('completions', {
      schema: { title: 'string' },
      partitions: { maxPartitions: 1 },
    })
    await engine.insertBatch('completions', completionDocuments())
  })

  afterEach(async () => {
    await engine.shutdown()
  })

  it('caps a caller of the public method at the client limit', async () => {
    const result = await engine.suggest('completions', { prefix: PREFIX, limit: 1_000 })
    expect(result.terms.length).toBe(MAX_SUGGEST_LIMIT)
  })

  it('lets a coordinator oversample a node beyond the client limit', async () => {
    const result = await engine.suggestPartitions('completions', { prefix: PREFIX, limit: 160 }, [0])
    expect(result.terms.length).toBe(160)
  })

  it('caps a coordinator at the scatter ceiling', async () => {
    const result = await engine.suggestPartitions('completions', { prefix: PREFIX, limit: 1_000 }, [0])
    expect(result.terms.length).toBe(MAX_SUGGEST_SCATTER_LIMIT)
  })
})
