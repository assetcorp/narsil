import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NarsilBackend, QueryHit, QueryRequest, QueryResponse } from '../backend'
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

export interface JudgingController {
  questions: JudgedQuestion[]
  hitsByQuestion: ReadonlyMap<number, QueryHit[]>
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

export function useJudging(backend: NarsilBackend, indexName: string): JudgingController {
  const [questions, setQuestions] = useState<JudgedQuestion[]>([])
  const [hitsByQuestion, setHitsByQuestion] = useState<ReadonlyMap<number, QueryHit[]>>(new Map())
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

    let cancelled = false
    setIsRetrieving(true)
    backend
      .query({ indexName, term: selectedQuestion.text, limit: JUDGING_POOL_DEPTH })
      .then(response => {
        if (cancelled) return
        setHitsByQuestion(previous => new Map(previous).set(selectedQuestion.id, response.hits))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setIsRetrieving(false)
      })

    return () => {
      cancelled = true
    }
  }, [backend, indexName, selectedQuestion, hitsByQuestion])

  const addQuestion = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return

      const existing = questions.find(question => question.text === trimmed)
      if (existing) {
        setSelectedQuestionId(existing.id)
        return
      }

      const id = nextQuestionId(questions)
      setQuestions([...questions, { id, text: trimmed, judgments: {} }])
      setSelectedQuestionId(id)
    },
    [questions],
  )

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

    const collected = new Map<number, QueryHit[]>()
    const requests: QueryRequest[] = questions.map(question => ({
      indexName,
      term: question.text,
      limit: JUDGING_POOL_DEPTH,
    }))

    const receive = (position: number, response: QueryResponse) => {
      collected.set(questions[position].id, response.hits)
      setProgress(position + 1)
    }

    try {
      if (backend.batchQuery) {
        await backend.batchQuery(requests, receive)
      } else {
        for (let position = 0; position < requests.length; position++) {
          if (abortRef.current) break
          receive(position, await backend.query(requests[position]))
        }
      }
      setHitsByQuestion(previous => new Map([...previous, ...collected]))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setIsRunning(false)
    }
  }, [backend, indexName, questions])

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
