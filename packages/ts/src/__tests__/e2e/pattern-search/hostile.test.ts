import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_FILTER_TESTS } from '../../../filters/constants'
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
const MAX_PATTERN_POSITIONS = 2_048

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
        { fields: { body: { eq: 'x', caseFold: true } } },
        { fields: { body: { eq: 'x', caseFold: false } } },
        { fields: { body: { contains: 'x' } } },
        { fields: { line: { contains: 'a'.repeat(MAX_TEXT_CODE_POINTS + 1) } } },
        { fields: { line: { contains: '😀'.repeat(MAX_TEXT_CODE_POINTS + 1) } } },
        { fields: { sku: { in: ['ok', 'b'.repeat(MAX_TEXT_CODE_POINTS + 1)] } } },
        { fields: { line: { contains: 'ﬃ'.repeat(700), caseFold: true } } },
        { fields: { line: { regex: '(?=refused)' } } },
        { fields: { line: { regex: '(a)\\1' } } },
        { fields: { line: { regex: 'a*?' } } },
        { fields: { line: { regex: `${'('.repeat(33)}a${')'.repeat(33)}` } } },
        { fields: { line: { regex: 'a{2049}' } } },
        { fields: { line: { regex: '(ab){1024}c' } } },
        { fields: { line: { regex: 'a'.repeat(MAX_TEXT_CODE_POINTS + 1) } } },
        { fields: { line: { regex: '<9-1>' } } },
        { fields: { line: { regex: ['a'] } } },
        { fields: { line: { wildcard: 'abc\\' } } },
        { fields: { line: { wildcard: 7 } } },
        { fields: { body: { regex: 'entry' } } },
        { fields: { body: { wildcard: 'entry' } } },
      ]
      for (const filters of malformed) await expectRejected(server, filters, 'SEARCH_INVALID_FILTER')
      await expectRejected(server, { fields: { nowhere: { contains: 'x' } } }, 'SEARCH_INVALID_FIELD')
      expect((await timedSearch(server, searchBody(NORMAL_FILTERS))).status).toBe(200)
    },
  )

  it.skipIf(!runnable)('accepts each test at the edge of the limits', async () => {
    const atLimit: unknown[] = [
      { fields: { line: { contains: 'a'.repeat(MAX_TEXT_CODE_POINTS) } } },
      { fields: { line: { contains: '😀'.repeat(MAX_TEXT_CODE_POINTS) } } },
      { fields: { line: { contains: 'ß'.repeat(MAX_TEXT_CODE_POINTS), caseFold: true } } },
      { fields: { line: { contains: '' } } },
      {
        fields: {
          line: {
            in: ['ß'.repeat(MAX_TEXT_CODE_POINTS), 'ẞ'.repeat(MAX_TEXT_CODE_POINTS), `${'ß'.repeat(1_023)}a`],
            caseFold: true,
          },
        },
      },
      {
        fields: {
          line: {
            nin: ['ß'.repeat(MAX_TEXT_CODE_POINTS), 'ẞ'.repeat(MAX_TEXT_CODE_POINTS)],
            caseFold: true,
          },
        },
      },
      { fields: { line: { regex: `${'('.repeat(32)}a${')'.repeat(32)}` } } },
      { fields: { line: { regex: 'q{2048}' } } },
      { fields: { line: { regex: `ß{1024}`, caseFold: true } } },
      { fields: { line: { regex: 'q'.repeat(MAX_TEXT_CODE_POINTS) } } },
      { fields: { line: { wildcard: `${'q'.repeat(MAX_TEXT_CODE_POINTS - 2)}*?` } } },
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
      const answered = await expectServedWhileHostile(server, hostile, NORMAL_FILTERS, 'a test past the work cap')
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
          'the most long or clauses that a filter holds',
          {
            or: Array.from({ length: MAX_FILTER_TESTS }, (_, at) => ({
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
          'a regex whose deterministic states outgrow the state budget',
          { fields: { line: { regex: `[ab]*a[ab]{${MAX_PATTERN_POSITIONS - 2}}` } } },
        ],
        ['a regex that keeps every position alive', { fields: { line: { regex: '(.*a){1000}c' } } }],
        [
          'a regex whose word edges guard many branches',
          {
            fields: {
              line: {
                regex: `(${Array.from({ length: 200 }, (_, at) => `\\b${String.fromCodePoint(0x4e00 + at)}`).join('|')})`,
              },
            },
          },
        ],
        ['a wildcard of many stars', { fields: { line: { wildcard: `${'*a'.repeat(500)}*` } } }],
        [
          'the most long regex or clauses that a filter holds',
          {
            or: Array.from({ length: MAX_FILTER_TESTS }, (_, at) => ({
              fields: { line: { regex: `[ab]*${String.fromCodePoint(0x4e00 + at)}[ab]{1000}` } },
            })),
          },
        ],
        [
          'the most ne tests that a filter holds',
          { or: Array.from({ length: MAX_FILTER_TESTS }, (_, at) => ({ fields: { sku: { ne: `SKU-${at}` } } })) },
        ],
      ]
      for (const [label, filters] of hostileFilters) {
        const answered = await expectServedWhileHostile(server, searchBody(filters), NORMAL_FILTERS, label)
        expect([200, 400], label).toContain(answered.status)
        if (answered.status === 400) expect(answered.code, label).toBe('SEARCH_WORK_CAP_EXCEEDED')
      }
    },
    180_000,
  )
})
