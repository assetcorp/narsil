import { Trash2 } from 'lucide-react'
import { type MouseEvent, useCallback } from 'react'
import type { JudgedQuestion } from '../../lib/judging'
import type { QueryMetrics } from '../../lib/metrics'
import { Button } from '../ui/button'
import { MetricBadge } from './QueryExplorer'

const UNMEASURED = '\u2014'

interface QuestionRowProps {
  question: JudgedQuestion
  metrics: QueryMetrics | undefined
  isSelected: boolean
  onSelect: (questionId: number) => void
  onRemove: (questionId: number) => void
}

function QuestionRow({ question, metrics, isSelected, onSelect, onRemove }: QuestionRowProps) {
  const handleSelect = useCallback(() => {
    onSelect(question.id)
  }, [onSelect, question.id])

  const handleRemove = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      onRemove(question.id)
    },
    [onRemove, question.id],
  )

  const judgedCount = Object.keys(question.judgments).length

  return (
    <tr
      className={`cursor-pointer border-b transition-colors hover:bg-muted/50 ${isSelected ? 'bg-accent' : ''}`}
      onClick={handleSelect}
    >
      <td className="px-3 py-1.5 font-mono">{question.id}</td>
      <td className="max-w-[200px] px-3 py-1.5">
        <span className="block truncate">{question.text}</span>
        <span className="text-[10px] text-muted-foreground">
          {judgedCount === 0 ? 'No documents marked yet' : `${judgedCount} marked`}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right font-mono">
        {metrics ? <MetricBadge value={metrics.ndcg10} /> : UNMEASURED}
      </td>
      <td className="px-3 py-1.5 text-right font-mono">
        {metrics ? <MetricBadge value={metrics.precision10} /> : UNMEASURED}
      </td>
      <td className="px-3 py-1.5 text-right font-mono">{metrics ? <MetricBadge value={metrics.ap} /> : UNMEASURED}</td>
      <td className="px-1 py-1.5 text-right">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={handleRemove}
        >
          <Trash2 />
          <span className="sr-only">Remove question {question.id}</span>
        </Button>
      </td>
    </tr>
  )
}

interface QuestionListProps {
  questions: JudgedQuestion[]
  metricsByQuestion: ReadonlyMap<number, QueryMetrics>
  selectedQuestionId: number | null
  onSelect: (questionId: number) => void
  onRemove: (questionId: number) => void
}

export function QuestionList({
  questions,
  metricsByQuestion,
  selectedQuestionId,
  onSelect,
  onRemove,
}: QuestionListProps) {
  return (
    <div className="min-w-0 rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Your Questions</h3>
        <p className="text-xs text-muted-foreground">
          Select a question to read its results and mark the documents that answer it.
        </p>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Question</th>
              <th className="px-3 py-2 text-right font-medium">nDCG</th>
              <th className="px-3 py-2 text-right font-medium">P@10</th>
              <th className="px-3 py-2 text-right font-medium">AP</th>
              <th className="px-1 py-2" />
            </tr>
          </thead>
          <tbody>
            {questions.map(question => (
              <QuestionRow
                key={question.id}
                question={question}
                metrics={metricsByQuestion.get(question.id)}
                isSelected={question.id === selectedQuestionId}
                onSelect={onSelect}
                onRemove={onRemove}
              />
            ))}
          </tbody>
        </table>
        {questions.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            Add a question above to start measuring retrieval quality on this index.
          </p>
        )}
      </div>
    </div>
  )
}
