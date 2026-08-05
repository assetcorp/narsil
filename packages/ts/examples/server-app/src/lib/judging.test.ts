import {
  deleteJudgedQuestions,
  evaluateJudgedQuestions,
  hitDocumentId,
  type JudgedQuestion,
  nextQuestionId,
  readJudgedQuestions,
  writeJudgedQuestions,
} from '@delali/narsil-example-shared/lib/judging'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function createLocalStorage() {
  const entries = new Map<string, string>()
  return {
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, value)
    },
    removeItem: (key: string): void => {
      entries.delete(key)
    },
  }
}

function question(id: number, text: string, judgments: Record<string, 0 | 1>): JudgedQuestion {
  return { id, text, judgments }
}

describe('judged question storage', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the questions written for an index and leaves other indexes alone', () => {
    writeJudgedQuestions('handbook', [question(1, 'how do I request leave?', { 'doc-4': 1 })])
    writeJudgedQuestions('tickets', [question(1, 'who owns billing?', {})])

    expect(readJudgedQuestions('handbook')).toEqual([question(1, 'how do I request leave?', { 'doc-4': 1 })])
    expect(readJudgedQuestions('tickets')).toEqual([question(1, 'who owns billing?', {})])
    expect(readJudgedQuestions('absent')).toEqual([])
  })

  it('drops stored entries that no longer match the question shape', () => {
    window.localStorage.setItem(
      'narsil-judged-questions',
      JSON.stringify({
        handbook: [
          { id: 1, text: 'valid', judgments: { 'doc-1': 1, 'doc-2': 7, 'doc-3': 0 } },
          { id: 2, text: '   ', judgments: {} },
          { id: 1, text: 'duplicate id', judgments: {} },
          { text: 'no id', judgments: {} },
          'not an object',
        ],
      }),
    )

    expect(readJudgedQuestions('handbook')).toEqual([question(1, 'valid', { 'doc-1': 1, 'doc-3': 0 })])
  })

  it('recovers from stored text that is not valid JSON', () => {
    window.localStorage.setItem('narsil-judged-questions', 'not json')
    expect(readJudgedQuestions('handbook')).toEqual([])
  })

  it('forgets an index once its questions are deleted', () => {
    writeJudgedQuestions('handbook', [question(1, 'how do I request leave?', {})])
    writeJudgedQuestions('tickets', [question(1, 'who owns billing?', {})])

    deleteJudgedQuestions('handbook')

    expect(readJudgedQuestions('handbook')).toEqual([])
    expect(readJudgedQuestions('tickets')).toEqual([question(1, 'who owns billing?', {})])
  })

  it('reads nothing when no browser storage is available', () => {
    vi.unstubAllGlobals()
    expect(readJudgedQuestions('handbook')).toEqual([])
  })
})

describe('nextQuestionId', () => {
  it('starts at one and never reuses an identifier of a removed question', () => {
    expect(nextQuestionId([])).toBe(1)
    expect(nextQuestionId([question(1, 'first', {}), question(2, 'second', {})])).toBe(3)
    expect(nextQuestionId([question(3, 'third', {})])).toBe(4)
  })
})

describe('hitDocumentId', () => {
  it('prefers the document identifier over the internal hit identifier', () => {
    expect(hitDocumentId({ id: 'internal-7', score: 1, document: { id: 'doc-9' } })).toBe('doc-9')
    expect(hitDocumentId({ id: 'internal-7', score: 1, document: { title: 'no identifier' } })).toBe('internal-7')
  })
})

describe('evaluateJudgedQuestions', () => {
  const ranked = new Map<number, string[]>([[1, ['doc-1', 'doc-2', 'doc-3']]])

  it('skips questions that have no results and questions with no marks', () => {
    const questions = [question(1, 'measured', { 'doc-2': 1 }), question(2, 'never retrieved', { 'doc-9': 1 })]

    const result = evaluateJudgedQuestions(questions, ranked)

    expect(result?.perQuery.map(entry => entry.queryId)).toEqual([1])
    expect(result?.aggregate.queriesEvaluated).toBe(1)
  })

  it('returns nothing until at least one question can be measured', () => {
    expect(evaluateJudgedQuestions([question(1, 'unmarked', {})], ranked)).toBeNull()
    expect(evaluateJudgedQuestions([], ranked)).toBeNull()
  })

  it('scores a single relevant document by the rank it was returned at', () => {
    const result = evaluateJudgedQuestions([question(1, 'measured', { 'doc-2': 1 })], ranked)

    expect(result?.perQuery[0].rr).toBeCloseTo(0.5, 10)
    expect(result?.perQuery[0].precision10).toBeCloseTo(0.1, 10)
    expect(result?.perQuery[0].ap).toBeCloseTo(0.5, 10)
    expect(result?.perQuery[0].ndcg10).toBeCloseTo(1 / Math.log2(3), 10)
  })

  it('treats a document marked not relevant the same as one never marked', () => {
    const marked = evaluateJudgedQuestions([question(1, 'measured', { 'doc-1': 0, 'doc-2': 1 })], ranked)
    const unmarked = evaluateJudgedQuestions([question(1, 'measured', { 'doc-2': 1 })], ranked)

    expect(marked?.aggregate).toEqual(unmarked?.aggregate)
  })

  it('averages every measured question into the aggregate', () => {
    const questions = [question(1, 'first', { 'doc-1': 1 }), question(2, 'second', { 'doc-2': 1 })]
    const rankedBoth = new Map<number, string[]>([
      [1, ['doc-1', 'doc-2']],
      [2, ['doc-1', 'doc-2']],
    ])

    const result = evaluateJudgedQuestions(questions, rankedBoth)

    expect(result?.aggregate.queriesEvaluated).toBe(2)
    expect(result?.aggregate.mrr).toBeCloseTo(0.75, 10)
    expect(result?.aggregate.map).toBeCloseTo(0.75, 10)
  })
})
