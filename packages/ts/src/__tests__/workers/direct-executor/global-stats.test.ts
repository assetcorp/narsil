import { describe, expect, it } from 'vitest'
import type { FanOutResult } from '../../../partitioning/fan-out'
import type { GlobalStatistics } from '../../../types/internal'
import { createDirectExecutor } from '../../../workers/direct-executor'
import { config, reqId } from './fixtures'

async function seedExecutor() {
  const executor = createDirectExecutor()
  await executor.execute({ type: 'createIndex', indexName: 'library', config, requestId: reqId() })
  await executor.execute({
    type: 'insert',
    indexName: 'library',
    docId: 'doc-1',
    document: { title: 'machine learning for libraries', score: 1 },
    requestId: reqId(),
  })
  await executor.execute({
    type: 'insert',
    indexName: 'library',
    docId: 'doc-2',
    document: { title: 'gardening for beginners', score: 2 },
    requestId: reqId(),
  })
  return executor
}

function queryAction(globalStats?: GlobalStatistics) {
  return {
    type: 'query' as const,
    indexName: 'library',
    params: { term: 'machine', scoring: 'broadcast' as const, includeScoreComponents: true },
    requestId: reqId(),
    ...(globalStats !== undefined ? { globalStats } : {}),
  }
}

describe('the executor a worker runs scores with the statistics the query action carries', () => {
  it('raises the inverse document frequency when the wire statistics describe a larger corpus', async () => {
    const executor = await seedExecutor()

    const withoutStats = await executor.execute<FanOutResult>(queryAction())
    expect(withoutStats.scored.length).toBe(1)
    const token = Object.keys(withoutStats.scored[0].idf)[0]
    const localIdf = withoutStats.scored[0].idf[token]

    const wireStats: GlobalStatistics = {
      totalDocuments: 100_000,
      docFrequencies: { [token]: 1 },
      totalFieldLengths: { title: 400_000 },
      averageFieldLengths: { title: 4 },
    }
    const withStats = await executor.execute<FanOutResult>(queryAction(wireStats))

    expect(withStats.scored.length).toBe(1)
    expect(withStats.scored[0].idf[token]).toBeGreaterThan(localIdf)
    await executor.shutdown()
  })

  it('scores broadcast without wire statistics exactly like document-frequency scoring', async () => {
    const executor = await seedExecutor()

    const broadcastNoStats = await executor.execute<FanOutResult>(queryAction())
    const dfs = await executor.execute<FanOutResult>({
      type: 'query',
      indexName: 'library',
      params: { term: 'machine', scoring: 'dfs', includeScoreComponents: true },
      requestId: reqId(),
    })

    expect(broadcastNoStats.scored).toEqual(dfs.scored)
    await executor.shutdown()
  })

  it('honours the scoring mode the query params ask for over the index default', async () => {
    const executor = await seedExecutor()

    const local = await executor.execute<FanOutResult>({
      type: 'query',
      indexName: 'library',
      params: { term: 'machine', includeScoreComponents: true },
      requestId: reqId(),
    })
    const token = Object.keys(local.scored[0].idf)[0]

    const wireStats: GlobalStatistics = {
      totalDocuments: 100_000,
      docFrequencies: { [token]: 1 },
      totalFieldLengths: { title: 400_000 },
      averageFieldLengths: { title: 4 },
    }
    const broadcast = await executor.execute<FanOutResult>(queryAction(wireStats))

    expect(broadcast.scored[0].idf[token]).toBeGreaterThan(local.scored[0].idf[token])
    await executor.shutdown()
  })
})
