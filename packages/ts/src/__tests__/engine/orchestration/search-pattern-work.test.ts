import { describe, expect, it, vi } from 'vitest'
import {
  MATCHER_STATE_BUDGET_BYTES,
  MAX_PATTERN_POSITIONS,
  PATTERN_WORK_FLUSH_UNITS,
} from '../../../core/pattern-index/constants'
import { PATTERN_HOST } from '../../../core/pattern-index/host'
import { widestPatternSplit } from '../../../core/pattern-index/matcher-budget'
import {
  createPatternWorkMeter,
  joinPatternWorkMeter,
  type SharedPatternWork,
} from '../../../core/pattern-index/work-meter'
import { searchViaWorker } from '../../../engine/orchestration/search'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { FanOutResult } from '../../../partitioning/fan-out'
import { compileExpression, programFootprint } from '../../../pattern/expression'
import { smallestMatcherBytes } from '../../../pattern/footprint'
import { SCRATCH_SLOTS_PER_THREAD_POOL } from '../../../vector/constants'
import { type OrchestratorHarness, type RecordedDispatch, recordingHarness, registryWith, settle } from './fixtures'

const EMPTY: FanOutResult = { scored: [], totalMatched: 0 }

function queries(harness: OrchestratorHarness): RecordedDispatch[] {
  return harness.dispatched.filter(entry => entry.action.type === 'query')
}

function patternWorkOf(entry: RecordedDispatch): SharedPatternWork {
  if (entry.action.type !== 'query') throw new Error('The copy received no query')
  return entry.action.patternWork
}

function answerAll(harness: OrchestratorHarness): void {
  for (const entry of harness.dispatched.splice(0)) entry.resolve(EMPTY)
}

function patternSearchHarness(copyCount: number): OrchestratorHarness {
  return recordingHarness(copyCount, ['prose'], copyCount, {
    indexRegistry: registryWith('prose', { title: 'string', code: 'verbatim' }),
  })
}

describe('the pattern work that a copy does for a search', () => {
  it('splits a search over no more copies than its matcher state budget can serve', async () => {
    const copyCount = SCRATCH_SLOTS_PER_THREAD_POOL
    const harness = patternSearchHarness(copyCount)
    const search = (filter: Record<string, unknown>) =>
      searchViaWorker(
        harness.state,
        'prose',
        { term: 'a', filters: { fields: { code: filter } } },
        undefined,
        undefined,
        createPatternWorkMeter(),
      )

    const longest = search({ contains: 'ß'.repeat(MAX_PATTERN_POSITIONS / 2), caseFold: true })
    await settle()
    const narrowed = queries(harness)
    expect(narrowed).toHaveLength(widestPatternSplit(smallestMatcherBytes(MAX_PATTERN_POSITIONS)))
    expect(narrowed.length).toBeLessThan(copyCount)
    expect(patternWorkOf(narrowed[0]).matcherStateBytes).toBeGreaterThanOrEqual(
      smallestMatcherBytes(MAX_PATTERN_POSITIONS),
    )
    answerAll(harness)
    await longest

    const regex = `[ab]*a[ab]{${MAX_PATTERN_POSITIONS - 2}}`
    const footprint = programFootprint(compileExpression('regex', regex, false, PATTERN_HOST).program)
    const widestRegex = search({ regex })
    await settle()
    const regexCopies = queries(harness)
    expect(regexCopies).toHaveLength(widestPatternSplit(footprint))
    expect(regexCopies.length).toBeLessThan(copyCount)
    expect(patternWorkOf(regexCopies[0]).matcherStateBytes).toBeGreaterThanOrEqual(footprint)
    answerAll(harness)
    await widestRegex

    const short = search({ contains: 'abc', caseFold: true })
    await settle()
    expect(queries(harness)).toHaveLength(copyCount)
    answerAll(harness)
    await short
  })

  it('keeps the work of a copy that failed in the count of the search that falls back', async () => {
    const harness = recordingHarness(1, ['prose'])

    const failedSearch = createPatternWorkMeter(100)
    const failing = searchViaWorker(harness.state, 'prose', { term: 'a' }, undefined, undefined, failedSearch)
    await settle()
    const [failingCopy] = queries(harness)
    const copyWork = joinPatternWorkMeter(patternWorkOf(failingCopy))
    copyWork.add(40)
    failingCopy.reject(new Error('timed out'))
    expect(await failing).toBeNull()
    expect(failedSearch.remaining()).toBe(60)

    failedSearch.add(10)
    copyWork.add(30)
    expect(failedSearch.remaining()).toBe(20)
    expect(() => failedSearch.add(21)).toThrow(expect.objectContaining({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED }))
  })

  it('counts the work that the search does while its copies work', async () => {
    const harness = recordingHarness(1, ['prose'])
    const search = createPatternWorkMeter(100)
    const pending = searchViaWorker(harness.state, 'prose', { term: 'a' }, undefined, undefined, search)
    await settle()
    const [copy] = queries(harness)
    joinPatternWorkMeter(patternWorkOf(copy)).add(40)
    search.add(15)
    copy.resolve(EMPTY)
    await pending
    expect(search.remaining()).toBe(45)
  })

  it('raises the cap error when the work of a failed copy already passed the cap', async () => {
    const harness = recordingHarness(1, ['prose'])

    const pending = searchViaWorker(
      harness.state,
      'prose',
      { term: 'a' },
      undefined,
      undefined,
      createPatternWorkMeter(30),
    )
    await settle()
    const [failingCopy] = queries(harness)
    const copyWork = joinPatternWorkMeter(patternWorkOf(failingCopy))
    expect(() => copyWork.add(35)).toThrow(expect.objectContaining({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED }))
    failingCopy.reject(new Error('worker gone'))
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED })
  })

  it('waits for every copy of a split search before it falls back, and counts the work of each', async () => {
    const harness = recordingHarness(2, ['prose'], 4)
    const search = createPatternWorkMeter(100)
    let finished = false
    const pending = searchViaWorker(harness.state, 'prose', { term: 'a' }, undefined, undefined, search).finally(() => {
      finished = true
    })
    await settle()
    const [left, right] = queries(harness)
    joinPatternWorkMeter(patternWorkOf(left)).add(30)
    left.reject(new Error('worker gone'))
    await settle()
    expect(finished).toBe(false)

    joinPatternWorkMeter(patternWorkOf(right)).add(20)
    right.resolve(EMPTY)
    expect(await pending).toBeNull()
    expect(search.remaining()).toBe(50)
  })

  it('reports the work in what the copy answers', async () => {
    const harness = recordingHarness(1, ['prose'])
    const answeredSearch = createPatternWorkMeter(100)
    const answering = searchViaWorker(harness.state, 'prose', { term: 'b' }, undefined, undefined, answeredSearch)
    await settle()
    const [answeringCopy] = queries(harness)
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

  it('shares one count and splits the matcher state budget and the flush interval between the copies of a split search', async () => {
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
    expect(leftWork.matcherStateBytes).toBe(Math.floor(MATCHER_STATE_BUDGET_BYTES / 2))
    expect(leftWork.flushUnits + rightWork.flushUnits).toBeLessThanOrEqual(PATTERN_WORK_FLUSH_UNITS)
    joinPatternWorkMeter(leftWork).add(60)
    expect(() => joinPatternWorkMeter(rightWork).add(41)).toThrow(
      expect.objectContaining({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED }),
    )

    answerAll(harness)
    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.SEARCH_WORK_CAP_EXCEEDED })
  })

  it('sends a search with a pattern test to one copy when the runtime offers no shared memory', async () => {
    vi.stubGlobal('SharedArrayBuffer', undefined)
    try {
      const harness = patternSearchHarness(4)
      const pending = searchViaWorker(
        harness.state,
        'prose',
        { term: 'a', filters: { fields: { code: { contains: '' } } } },
        undefined,
        undefined,
        createPatternWorkMeter(100),
      )
      await settle()
      expect(queries(harness)).toHaveLength(1)
      answerAll(harness)
      await pending
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
