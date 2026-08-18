import type { Hit } from '@delali/narsil'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QUERY_CONCURRENCY, runPooled } from '../lib/concurrency'
import type { JudgedQuestion, RelevanceGrade } from '../lib/judging'
import {
  evaluateJudgedQuestions,
  hitDocumentId,
  JUDGING_POOL_DEPTH,
  nextQuestionId,
  readJudgedQuestions,
  writeJudgedQuestions,
} from '../lib/judging'
import type { BenchmarkResult } from '../lib/metrics'
import type { QueryRunner } from '../query-runner'

export interface JudgingController {
  questions: JudgedQuestion[]
  hitsByQuestion: ReadonlyMap<number, Hit[]>
  selectedQuestion: JudgedQuestion | null
  result: BenchmarkResult | null
  isRunning: boolean
  isRetrieving: boolean
  progress: number
  error: string | null
  addQuestion: (text: string) => void
  removeQuestion: (questionId: number) => void
  selectQuestion: (questionId: number | null) => void
  judgeDocument: (questionId: number, documentId: string, grade: RelevanceGrade) => void
  run: () => Promise<void>
  abort: () => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useJudging(runQuery: QueryRunner, indexName: string): JudgingController {
  const [questions, setQuestions] = useState<JudgedQuestion[]>([])
  const [hitsByQuestion, setHitsByQuestion] = useState<ReadonlyMap<number, Hit[]>>(new Map())
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [isRetrieving, setIsRetrieving] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [restoredIndexName, setRestoredIndexName] = useState<string | null>(null)
  const abortRef = useRef(false)

  useEffect(() => {
    setQuestions(readJudgedQuestions(indexName))
    setHitsByQuestion(new Map())
    setSelectedQuestionId(null)
    setProgress(0)
    setError(null)
    setRestoredIndexName(indexName)
  }, [indexName])

  useEffect(() => {
    if (restoredIndexName !== indexName) return
    try {
      writeJudgedQuestions(indexName, questions)
    } catch (err) {
      setError(`Your questions could not be saved for the next visit: ${errorMessage(err)}`)
    }
  }, [restoredIndexName, indexName, questions])

  const selectedQuestion = useMemo(
    () => questions.find(question => question.id === selectedQuestionId) ?? null,
    [questions, selectedQuestionId],
  )

  useEffect(() => {
    if (selectedQuestion === null) return
    if (hitsByQuestion.has(selectedQuestion.id)) return

    const controller = new AbortController()
    setIsRetrieving(true)
    runQuery(indexName, { term: selectedQuestion.text, limit: JUDGING_POOL_DEPTH }, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return
        setHitsByQuestion(previous => new Map(previous).set(selectedQuestion.id, result.hits))
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsRetrieving(false)
      })

    return () => {
      controller.abort()
    }
  }, [runQuery, indexName, selectedQuestion, hitsByQuestion])

  const addQuestion = useCallback((text: string) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return

    setQuestions(previous => {
      const existing = previous.find(question => question.text === trimmed)
      if (existing) {
        setSelectedQuestionId(existing.id)
        return previous
      }
      const id = nextQuestionId(previous)
      setSelectedQuestionId(id)
      return [...previous, { id, text: trimmed, judgments: {} }]
    })
  }, [])

  const removeQuestion = useCallback((questionId: number) => {
    setQuestions(previous => previous.filter(question => question.id !== questionId))
    setHitsByQuestion(previous => {
      if (!previous.has(questionId)) return previous
      const next = new Map(previous)
      next.delete(questionId)
      return next
    })
    setSelectedQuestionId(previous => (previous === questionId ? null : previous))
  }, [])

  const selectQuestion = useCallback((questionId: number | null) => {
    setSelectedQuestionId(questionId)
  }, [])

  const judgeDocument = useCallback((questionId: number, documentId: string, grade: RelevanceGrade) => {
    setQuestions(previous =>
      previous.map(question => {
        if (question.id !== questionId) return question
        const judgments = { ...question.judgments }
        if (judgments[documentId] === grade) {
          delete judgments[documentId]
        } else {
          judgments[documentId] = grade
        }
        return { ...question, judgments }
      }),
    )
  }, [])

  const run = useCallback(async () => {
    if (questions.length === 0) return

    abortRef.current = false
    setIsRunning(true)
    setProgress(0)
    setError(null)

    const collected = new Map<number, Hit[]>()
    try {
      await runPooled(
        questions,
        QUERY_CONCURRENCY,
        async question => {
          const result = await runQuery(indexName, { term: question.text, limit: JUDGING_POOL_DEPTH })
          collected.set(question.id, result.hits)
          setProgress(collected.size)
        },
        () => abortRef.current,
      )
      setHitsByQuestion(previous => new Map([...previous, ...collected]))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setIsRunning(false)
    }
  }, [runQuery, indexName, questions])

  const abort = useCallback(() => {
    abortRef.current = true
  }, [])

  const result = useMemo(() => {
    const rankedByQuestion = new Map<number, string[]>()
    for (const [questionId, hits] of hitsByQuestion) {
      rankedByQuestion.set(questionId, hits.map(hitDocumentId))
    }
    return evaluateJudgedQuestions(questions, rankedByQuestion)
  }, [questions, hitsByQuestion])

  return {
    questions,
    hitsByQuestion,
    selectedQuestion,
    result,
    isRunning,
    isRetrieving,
    progress,
    error,
    addQuestion,
    removeQuestion,
    selectQuestion,
    judgeDocument,
    run,
    abort,
  }
}
