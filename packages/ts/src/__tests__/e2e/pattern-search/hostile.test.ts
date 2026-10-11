import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NarsilConfig } from '../../../types/config'
import type { AnyDocument } from '../../../types/schema'
import { seededRandom } from '../../filters/pattern/random-corpus'
import { operationsCorpus } from './corpus'
import { loadCorpus, NO_WORKERS, type PatternServer, startPatternServer, WORKER_COPIES, WORKERS_BUILT } from './harness'
import {
  expectRejected,
  expectServedWhileHostile,
  longValueCorpus,
  repeatedCodePoints,
  searchBody,
  timedSearch,
} from './hostile'

const CJK_FIRST = 0x4e00
const CJK_SPAN = 20_000
const LONG_VALUE_CODE_POINTS = 8_000
const MAX_TEXT_CODE_POINTS = 1_024
const NORMAL_FILTERS = { fields: { sku: { eq: 'SKU-2022-00002' } } }
const MISSED_TEST_POSITION = 30
const PARTITIONS = 8

function nearMissOf(test: string): string {
  const characters = Array.from(test)
  characters[MISSED_TEST_POSITION] = 'x'
  return characters.join('')
}

function scatteredCorpus(count: number, test: string): AnyDocument[] {
  const random = seededRandom(31)
  return Array.from({ length: count }, (_, at) => {
    const scattered = Array.from({ length: LONG_VALUE_CODE_POINTS - MAX_TEXT_CODE_POINTS }, () =>
      String.fromCodePoint(CJK_FIRST + Math.floor(random() * CJK_SPAN)),
    ).join('')
    return { id: `scattered${at}`, body: 'entry', line: `${nearMissOf(test)}${scattered}` }
  })
}

const HOSTILE_TEXT = repeatedCodePoints(CJK_FIRST, MAX_TEXT_CODE_POINTS)

describe.each([
  { where: 'on the main thread', workers: NO_WORKERS, runnable: true },
  { where: 'on worker copies', workers: WORKER_COPIES, runnable: WORKERS_BUILT },
])('a server facing hostile pattern searches $where', ({ workers, runnable }) => {
  let server: PatternServer

  beforeAll(async () => {
    if (!runnable) return
    const config: NarsilConfig = { workers }
    server = await startPatternServer(config)
    await loadCorpus(
      server,
      [
        ...operationsCorpus(2_000, 21),
        ...longValueCorpus(40, LONG_VALUE_CODE_POINTS),
        ...scatteredCorpus(40, HOSTILE_TEXT),
      ],
      PARTITIONS,
    )
  }, 120_000)

  afterAll(async () => {
    if (runnable) await server.stop()
  })

  it.skipIf(!runnable)(
    'rejects each malformed pattern test with SEARCH_INVALID_FILTER and keeps answering',
    async () => {
      const malformed: unknown[] = [
        { fields: { line: { contains: 5 } } },
        { fields: { line: { contains: null } } },
        { fields: { line: { contains: ['a'] } } },
        { fields: { line: { contains: 'a', caseFold: 'yes' } } },
        { fields: { line: { contains: 'a', caseFold: 1 } } },
        { fields: { sku: { in: 'SKU-2022-00002' } } },
        { fields: { body: { contains: 'entry' } } },
        { fields: { lineText: { eq: 'x', caseFold: true } } },
        { fields: { lineText: { eq: 'x', caseFold: false } } },
        { fields: { nowhere: { contains: 'x' } } },
        { fields: { line: { contains: 'a'.repeat(MAX_TEXT_CODE_POINTS + 1) } } },
        { fields: { line: { contains: '😀'.repeat(MAX_TEXT_CODE_POINTS + 1) } } },
        { fields: { sku: { in: ['ok', 'b'.repeat(MAX_TEXT_CODE_POINTS + 1)] } } },
        { fields: { line: { contains: 'ﬃ'.repeat(700), caseFold: true } } },
      ]
      for (const filters of malformed) await expectRejected(server, filters, 'SEARCH_INVALID_FILTER')
      expect((await timedSearch(server, searchBody(NORMAL_FILTERS))).status).toBe(200)
    },
  )

  it.skipIf(!runnable)('accepts each test at the edge of the limits', async () => {
    const atLimit: unknown[] = [
      { fields: { line: { contains: 'a'.repeat(MAX_TEXT_CODE_POINTS) } } },
      { fields: { line: { contains: '😀'.repeat(MAX_TEXT_CODE_POINTS) } } },
      { fields: { line: { contains: 'ß'.repeat(MAX_TEXT_CODE_POINTS), caseFold: true } } },
      { fields: { line: { contains: '' } } },
    ]
    for (const filters of atLimit) {
      const response = await timedSearch(server, searchBody(filters))
      expect({ status: response.status, code: response.code }, JSON.stringify(filters).slice(0, 80)).toEqual({
        status: 200,
        code: null,
      })
    }
  })

  it.skipIf(!runnable)(
    'stops a search whose matcher work passes the cap, and answers another search meanwhile',
    async () => {
      const hostile = searchBody({ fields: { line: { contains: `${'a'.repeat(MAX_TEXT_CODE_POINTS - 1)}b` } } })
      const answered = await expectServedWhileHostile(server, hostile, NORMAL_FILTERS)
      expect({ status: answered.status, code: answered.code }).toEqual({
        status: 400,
        code: 'SEARCH_WORK_CAP_EXCEEDED',
      })
    },
    60_000,
  )

  it.skipIf(!runnable)(
    'answers within the deadline each search built to cost the most work below the cap',
    async () => {
      const hostileFilters: Array<[string, unknown]> = [
        ['a two-character test that checks every long value', { fields: { line: { contains: 'aa' } } }],
        [
          'a long test of distinct characters against scattered values',
          { fields: { line: { contains: HOSTILE_TEXT } } },
        ],
        [
          'a body of thousands of long or clauses',
          {
            or: Array.from({ length: 4_500 }, (_, at) => ({
              fields: { line: { contains: repeatedCodePoints(CJK_FIRST + at, 1_000) } },
            })),
          },
        ],
        [
          'an in list of thousands of long values',
          {
            fields: {
              sku: { in: Array.from({ length: 4_500 }, (_, at) => repeatedCodePoints(CJK_FIRST + at, 1_000)) },
            },
          },
        ],
        [
          'thousands of ne tests',
          { or: Array.from({ length: 5_000 }, (_, at) => ({ fields: { sku: { ne: `SKU-${at}` } } })) },
        ],
      ]
      for (const [label, filters] of hostileFilters) {
        const answered = await expectServedWhileHostile(server, searchBody(filters), NORMAL_FILTERS)
        expect([200, 400], label).toContain(answered.status)
        if (answered.status === 400) expect(answered.code, label).toBe('SEARCH_WORK_CAP_EXCEEDED')
      }
    },
    180_000,
  )
})
