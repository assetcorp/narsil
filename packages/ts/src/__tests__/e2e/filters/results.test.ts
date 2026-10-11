import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import type { FilterExpression } from '../../../types/filters'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { startTestServer } from '../../server/helpers'
import { afterChurn, churnOf, INDEX, productCorpus } from './corpus'
import {
  answerOf,
  applyChurn,
  expectAgreesWithOracle,
  type FilterAnswer,
  type FilterServer,
  startFilterServer,
  WORKERS_BUILT,
} from './harness'
import { fieldProbes, randomExpression } from './probes'

const CORPUS_SIZE = 2_000
const FIELD_PROBES = 400
const EXPRESSIONS = 250

describe('filters sent over HTTP to differently built servers, after updates and removals', () => {
  const loaded = productCorpus(CORPUS_SIZE, 51)
  const churn = churnOf(loaded, 55)
  const documents = afterChurn(loaded, churn)
  const allIds = documents.map(document => String(document.id)).sort()
  const targets: FilterServer[] = []

  beforeAll(async () => {
    targets.push(await startFilterServer('one partition', { workers: { enabled: false } }, loaded, 1))
    targets.push(await startFilterServer('four partitions', { workers: { enabled: false } }, loaded, 4))
    if (WORKERS_BUILT) {
      targets.push(
        await startFilterServer(
          'worker copies',
          { workers: { promotionThreshold: 200, count: 3, mainCopyQueries: 'none' } },
          loaded,
          4,
        ),
      )
    }
    for (const target of targets) await applyChurn(target, churn)
  }, 120_000)

  afterAll(async () => {
    for (const target of targets) await target.server.stop()
  })

  async function expectConsistent(filters: FilterExpression): Promise<FilterAnswer> {
    const label = JSON.stringify(filters)
    const [reference, ...others] = await Promise.all(targets.map(target => answerOf(target, filters)))
    expect(reference.listed, label).toEqual(reference.searched)
    expect(reference.counted, label).toBe(reference.searched.length)
    for (const [at, other] of others.entries()) expect(other, `${targets[at + 1].label} ${label}`).toEqual(reference)
    expectAgreesWithOracle(documents, filters, reference.searched)
    return reference
  }

  it('answers every field test the same way in a search, a list, and a count, on every server, as the reference does', async () => {
    let decidedAnywhere = 0
    for (const { field, filter } of fieldProbes(FIELD_PROBES, 52)) {
      const filters = { fields: { [field]: filter } } as FilterExpression
      const answer = await expectConsistent(filters)
      decidedAnywhere += answer.searched.length
      const negated = await answerOf(targets[0], { not: filters })
      expect(negated.searched, `not ${JSON.stringify(filters)}`).toEqual(
        allIds.filter(id => !answer.searched.includes(id)),
      )
    }
    expect(decidedAnywhere).toBeGreaterThan(FIELD_PROBES * 10)
  }, 300_000)

  it('answers nested and, or, and not expressions as the intersection, union, and complement of their parts', async () => {
    const random = seededRandom(53)
    for (let at = 0; at < EXPRESSIONS; at++) {
      const expression = randomExpression(random, 3)
      const answer = await expectConsistent(expression)
      if (expression.and !== undefined || expression.or !== undefined) {
        const parts = await Promise.all(
          (expression.and ?? expression.or ?? []).map(child => answerOf(targets[0], child)),
        )
        const combined =
          expression.and !== undefined
            ? allIds.filter(id => parts.every(part => part.searched.includes(id)))
            : allIds.filter(id => parts.some(part => part.searched.includes(id)))
        expect(answer.searched, JSON.stringify(expression)).toEqual(combined)
      }
    }
  }, 300_000)

  it('answers every field test the same way after the index moves into another server through a snapshot', async () => {
    const snapshot = await targets[1].client.snapshot(INDEX)
    const restored = await startTestServer(undefined, { workers: { enabled: false } })
    try {
      const client = createNarsilClient({ url: restored.base })
      const task = await client.restore(INDEX, snapshot)
      expect((await client.waitForTask(task.id)).status).toBe('succeeded')
      const target: FilterServer = { label: 'restored', server: restored, client }
      for (const { field, filter } of fieldProbes(150, 54)) {
        const filters = { fields: { [field]: filter } } as FilterExpression
        expect(await answerOf(target, filters), JSON.stringify(filters)).toEqual(await answerOf(targets[1], filters))
      }
    } finally {
      await restored.stop()
    }
  }, 120_000)
})
