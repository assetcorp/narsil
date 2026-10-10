import { describe, expect, it } from 'vitest'
import { MAX_MATCHER_STATE_BYTES } from '../../../core/pattern-index/constants'
import {
  createPatternWorkMeter,
  joinPatternWorkMeter,
  type SharedPatternWork,
} from '../../../core/pattern-index/work-meter'
import { searchViaWorker } from '../../../engine/orchestration/search'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { FanOutResult } from '../../../partitioning/fan-out'
import { type OrchestratorHarness, type RecordedDispatch, recordingHarness, settle } from './fixtures'

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
    joinPatternWorkMeter(patternWorkOf(answeringCopy)).add(40)
    answeringCopy.resolve(EMPTY)
    await answering
    expect(answeredSearch.remaining()).toBe(60)
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
