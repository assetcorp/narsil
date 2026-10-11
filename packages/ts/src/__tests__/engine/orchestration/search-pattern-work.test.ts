import { describe, expect, it, vi } from 'vitest'
import { MAX_MATCHER_STATE_BYTES, MAX_PATTERN_POSITIONS } from '../../../core/pattern-index/constants'
import { smallestMatcherBytes, widestPatternSplit } from '../../../core/pattern-index/matcher-budget'
import {
  createPatternWorkMeter,
  joinPatternWorkMeter,
  type SharedPatternWork,
} from '../../../core/pattern-index/work-meter'
import { searchViaWorker } from '../../../engine/orchestration/search'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { FanOutResult } from '../../../partitioning/fan-out'
import { SCRATCH_SLOTS_PER_THREAD_POOL } from '../../../vector/constants'
import { type OrchestratorHarness, type RecordedDispatch, recordingHarness, registryWith, settle } from './fixtures'

const EMPTY: FanOutResult = { scored: [], totalMatched: 0 }

function queries(harness: OrchestratorHarness): RecordedDispatch[] {
  return harness.dispatched.filter(entry => entry.action.type === 'query')
}

function patternWorkOf(entry: RecordedDispatch): SharedPatternWork {
  if (entry.action.type !== 'query' || entry.action.patternWork === undefined) {
    throw new Error('The copy received no pattern work count')
  }
  return entry.action.patternWork
}

describe('the pattern work that a copy does for a search', () => {
  it('splits a search over no more copies than its matcher state budget can serve', async () => {
    const copyCount = SCRATCH_SLOTS_PER_THREAD_POOL
    const harness = recordingHarness(copyCount, ['prose'], copyCount, {
      indexRegistry: registryWith('prose', { title: 'string', code: 'verbatim' }),
    })
    const search = (contains: string) =>
      searchViaWorker(
        harness.state,
        'prose',
        { term: 'a', filters: { fields: { code: { contains, caseFold: true } } } },
        undefined,
        undefined,
        createPatternWorkMeter(),
      )

    const longest = search('ß'.repeat(MAX_PATTERN_POSITIONS / 2))
    await settle()
    const narrowed = queries(harness)
    expect(narrowed).toHaveLength(widestPatternSplit(MAX_PATTERN_POSITIONS))
    expect(narrowed.length).toBeLessThan(copyCount)
    expect(patternWorkOf(narrowed[0]).matcherStateBytes).toBeGreaterThanOrEqual(
      smallestMatcherBytes(MAX_PATTERN_POSITIONS),
    )
    harness.releaseAll()
    await longest

    const short = search('abc')
    await settle()
    expect(queries(harness)).toHaveLength(copyCount)
    harness.releaseAll()
    await short
  })

  it('joins the search count only once the copy answers', async () => {
    const harness = recordingHarness(1, ['prose'])

    const failedSearch = createPatternWorkMeter(100)
    const failing = searchViaWorker(harness.state, 'prose', { term: 'a' }, undefined, undefined, failedSearch)
    await settle()
    const [failingCopy] = queries(harness)
    joinPatternWorkMeter(patternWorkOf(failingCopy)).add(40)
    failingCopy.reject(new Error('worker gone'))
    expect(await failing).toBeNull()
    expect(failedSearch.remaining()).toBe(100)

    const answeredSearch = createPatternWorkMeter(100)
    const answering = searchViaWorker(harness.state, 'prose', { term: 'b' }, undefined, undefined, answeredSearch)
    await settle()
    const answeringCopy = queries(harness)[1]
    const copyWork = joinPatternWorkMeter(patternWorkOf(answeringCopy))
    copyWork.add(40)
    answeringCopy.resolve({ ...EMPTY, patternWorkSpent: copyWork.spent() })
    await answering
    expect(answeredSearch.remaining()).toBe(60)
  })

  it('adds the work that each copy reports when the runtime offers no shared memory', async () => {
    vi.stubGlobal('SharedArrayBuffer', undefined)
    try {
      const harness = recordingHarness(2, ['prose'], 4)
      const search = createPatternWorkMeter(100)
      const pending = searchViaWorker(harness.state, 'prose', { term: 'a' }, undefined, undefined, search)
      await settle()
      const [left, right] = queries(harness)
      expect(patternWorkOf(left).counter).toBeNull()
      const leftWork = joinPatternWorkMeter(patternWorkOf(left))
      const rightWork = joinPatternWorkMeter(patternWorkOf(right))
      leftWork.add(30)
      rightWork.add(25)
      left.resolve({ ...EMPTY, patternWorkSpent: leftWork.spent() })
      right.resolve({ ...EMPTY, patternWorkSpent: rightWork.spent() })
      await pending
      expect(search.remaining()).toBe(45)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('passes the cap error of a copy to the caller in place of a fallback', async () => {
    const harness = recordingHarness(1, ['prose'])

    const pending = searchViaWorker(
      harness.state,
      'prose',
      { term: 'a' },
      undefined,
      undefined,
      createPatternWorkMeter(10),
    )
    await settle()
    queries(harness)[0].reject(new NarsilError(ErrorCodes.SEARCH_WORK_CAP_EXCEEDED, 'over the cap'))

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED })
  })

  it('shares one count and splits the matcher state budget between the copies of a split search', async () => {
    const harness = recordingHarness(2, ['prose'], 4)

    const pending = searchViaWorker(
      harness.state,
      'prose',
      { term: 'a' },
      undefined,
      undefined,
      createPatternWorkMeter(100),
    )
    await settle()
    const [left, right] = queries(harness)
    const leftWork = patternWorkOf(left)
    const rightWork = patternWorkOf(right)

    expect(leftWork.counter).toBe(rightWork.counter)
    expect(leftWork.matcherStateBytes).toBe(Math.floor(MAX_MATCHER_STATE_BYTES / 2))
    joinPatternWorkMeter(leftWork).add(60)
    expect(() => joinPatternWorkMeter(rightWork).add(41)).toThrow(
      expect.objectContaining({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED }),
    )

    harness.releaseAll()
    await pending
  })
})
