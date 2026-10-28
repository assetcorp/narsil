import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import type { QueryParams } from '../../../types/search'
import { FIRST_RULES, garageCorpus, INDEX, registerGarageLanguage } from './corpus'
import { expectEveryProbe, garageConfig, hitsOf, NO_WORKERS, RESULT_LIMIT } from './harness'
import { createOracle } from './oracle'

const engines: Narsil[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

describe('DFS scoring on one engine that holds several partitions', () => {
  it('counts every typo match and synonym across all partitions, matching the oracle', async () => {
    const documents = garageCorpus(1_200, 91)
    const engine = await createNarsil({ workers: NO_WORKERS })
    engines.push(engine)
    await engine.createIndex(INDEX, {
      ...garageConfig(FIRST_RULES),
      partitions: { maxDocsPerPartition: 300, maxPartitions: 8 },
    })
    const inserted = await engine.insertBatch(INDEX, documents)
    expect(inserted.failed).toEqual([])
    expect(engine.getPartitionStats(INDEX).length).toBeGreaterThan(2)

    for (const rules of [FIRST_RULES, []]) {
      await engine.updateSynonyms(INDEX, rules)
      await expectEveryProbe(
        async query =>
          hitsOf(await engine.query(INDEX, { ...query, scoring: 'dfs', limit: RESULT_LIMIT } as QueryParams)),
        createOracle(documents, rules),
        `dfs with ${rules.length} rules`,
      )
    }
  }, 180_000)
})
