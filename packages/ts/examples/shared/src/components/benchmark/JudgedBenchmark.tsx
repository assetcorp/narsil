import { type ChangeEvent, type FormEvent, useCallback, useMemo, useState } from 'react'
import type { NarsilBackend } from '../../backend'
import { useJudging } from '../../hooks/use-judging'
import type { QueryMetrics } from '../../lib/metrics'
import type { LoadedIndex } from '../../types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Progress } from '../ui/progress'
import { AggregateTable } from './AggregateTable'
import { JudgingPanel } from './JudgingPanel'
import { QuestionList } from './QuestionList'

interface QuestionComposerProps {
  onAdd: (text: string) => void
}

function QuestionComposer({ onAdd }: QuestionComposerProps) {
  const [text, setText] = useState('')

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setText(event.target.value)
  }, [])

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      onAdd(text)
      setText('')
    },
    [onAdd, text],
  )

  return (
    <form className="mb-6 flex gap-2" onSubmit={handleSubmit}>
      <Input
        type="text"
        value={text}
        onChange={handleChange}
        placeholder="Ask a question your documents should answer..."
        className="focus-visible:ring-1"
      />
      <Button type="submit" disabled={text.trim().length === 0}>
        Add question
      </Button>
    </form>
  )
}

interface JudgedBenchmarkProps {
  backend: NarsilBackend
  index: LoadedIndex
}

export function JudgedBenchmark({ backend, index }: JudgedBenchmarkProps) {
  const judging = useJudging(backend, index.name)

  const metricsByQuestion = useMemo(() => {
    const byQuestion = new Map<number, QueryMetrics>()
    for (const metrics of judging.result?.perQuery ?? []) {
      byQuestion.set(metrics.queryId, metrics)
    }
    return byQuestion
  }, [judging.result])

  const questionCount = judging.questions.length
  const hasQuestions = questionCount > 0

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Ask your own questions of <span className="font-mono font-medium text-foreground">{index.name}</span>, mark
          the documents that answer each one, and read the same figures the SciFact benchmark reports. Your questions
          and marks stay on this machine and survive a reload.
        </p>
        <div className="flex gap-2">
          {judging.isRunning ? (
            <Button variant="destructive" size="sm" onClick={judging.abort}>
              Abort
            </Button>
          ) : (
            <Button size="sm" disabled={!hasQuestions} onClick={judging.run}>
              {judging.hitsByQuestion.size > 0 ? 'Re-run' : 'Run Benchmark'}
            </Button>
          )}
        </div>
      </div>

      <QuestionComposer onAdd={judging.addQuestion} />

      {judging.isRunning && (
        <div className="mb-6">
          <Progress value={(judging.progress / questionCount) * 100} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Retrieving for question {judging.progress} of {questionCount}
          </p>
        </div>
      )}

      {judging.error && (
        <div className="mb-6 rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
          {judging.error}
        </div>
      )}

      <div className="flex flex-col gap-6">
        {judging.result ? (
          <AggregateTable metrics={judging.result.aggregate} />
        ) : (
          hasQuestions && (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
              Figures appear here once you mark at least one document for a question.
            </p>
          )
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <QuestionList
            questions={judging.questions}
            metricsByQuestion={metricsByQuestion}
            selectedQuestionId={judging.selectedQuestion?.id ?? null}
            onSelect={judging.selectQuestion}
            onRemove={judging.removeQuestion}
          />
          {judging.selectedQuestion && (
            <JudgingPanel
              question={judging.selectedQuestion}
              hits={judging.hitsByQuestion.get(judging.selectedQuestion.id)}
              datasetId={index.datasetId}
              isRetrieving={judging.isRetrieving}
              onJudge={judging.judgeDocument}
            />
          )}
        </div>
      </div>
    </>
  )
}
