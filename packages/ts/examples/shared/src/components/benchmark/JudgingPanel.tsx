import type { Hit } from '@delali/narsil'
import { Loader2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { type DisplayFieldMapping, displayHeading } from '../../lib/display-fields'
import { hitDocumentId, type JudgedQuestion, type RelevanceGrade } from '../../lib/judging'
import type { DatasetId } from '../../manifest'
import { ResultCard } from '../search/ResultCard'
import { ResultDetail } from '../search/ResultDetail'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'

const RELEVANT: RelevanceGrade = 1
const NOT_RELEVANT: RelevanceGrade = 0

interface JudgedResultRowProps {
  hit: Hit
  rank: number
  datasetId: DatasetId
  displayFields: DisplayFieldMapping | null
  grade: RelevanceGrade | undefined
  onJudge: (documentId: string, grade: RelevanceGrade) => void
  onOpen: (hit: Hit) => void
}

function JudgedResultRow({ hit, rank, datasetId, displayFields, grade, onJudge, onOpen }: JudgedResultRowProps) {
  const documentId = hitDocumentId(hit)

  const handleOpen = useCallback(() => {
    onOpen(hit)
  }, [onOpen, hit])

  const handleRelevant = useCallback(() => {
    onJudge(documentId, RELEVANT)
  }, [onJudge, documentId])

  const handleNotRelevant = useCallback(() => {
    onJudge(documentId, NOT_RELEVANT)
  }, [onJudge, documentId])

  return (
    <div className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
      <span className="w-6 shrink-0 pt-4 text-right font-mono text-xs text-muted-foreground">{rank}</span>
      <div className="min-w-0 flex-1">
        <ResultCard hit={hit} datasetId={datasetId} displayFields={displayFields} onClick={handleOpen} />
      </div>
      <div className="flex shrink-0 flex-col gap-1 pt-1">
        <Button
          type="button"
          size="xs"
          variant={grade === RELEVANT ? 'default' : 'outline'}
          aria-pressed={grade === RELEVANT}
          onClick={handleRelevant}
        >
          Relevant
        </Button>
        <Button
          type="button"
          size="xs"
          variant={grade === NOT_RELEVANT ? 'secondary' : 'outline'}
          aria-pressed={grade === NOT_RELEVANT}
          onClick={handleNotRelevant}
        >
          Not relevant
        </Button>
      </div>
    </div>
  )
}

interface JudgingPanelProps {
  question: JudgedQuestion
  hits: Hit[] | undefined
  datasetId: DatasetId
  displayFields: DisplayFieldMapping | null
  isRetrieving: boolean
  onJudge: (questionId: number, documentId: string, grade: RelevanceGrade) => void
}

export function JudgingPanel({ question, hits, datasetId, displayFields, isRetrieving, onJudge }: JudgingPanelProps) {
  const [openedHit, setOpenedHit] = useState<Hit | null>(null)

  const handleJudge = useCallback(
    (documentId: string, grade: RelevanceGrade) => {
      onJudge(question.id, documentId, grade)
    },
    [onJudge, question.id],
  )

  const handleSheetOpenChange = useCallback((open: boolean) => {
    if (!open) setOpenedHit(null)
  }, [])

  const judgedCount = Object.keys(question.judgments).length
  const relevantCount = Object.values(question.judgments).filter(grade => grade > 0).length
  const openedTitle = openedHit ? displayHeading(openedHit.document, displayFields, openedHit.id) : ''

  return (
    <div className="min-w-0 rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Question #{question.id}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{question.text}</p>
        {hits !== undefined && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {judgedCount} of {hits.length} retrieved documents marked, {relevantCount} of them relevant. Select a
            document to read every field before you mark it.
          </p>
        )}
      </div>

      {isRetrieving && hits === undefined ? (
        <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Narsil is retrieving documents for this question.
        </div>
      ) : (
        <div className="max-h-[32rem] overflow-auto">
          {hits?.map((hit, position) => (
            <JudgedResultRow
              key={hit.id}
              hit={hit}
              rank={position + 1}
              datasetId={datasetId}
              displayFields={displayFields}
              grade={question.judgments[hitDocumentId(hit)]}
              onJudge={handleJudge}
              onOpen={setOpenedHit}
            />
          ))}
          {hits !== undefined && hits.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">
              This question matched no documents in the index.
            </p>
          )}
        </div>
      )}

      <Sheet open={openedHit !== null} onOpenChange={handleSheetOpenChange}>
        <SheetContent side="right" className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="truncate">{openedTitle}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">{openedHit && <ResultDetail hit={openedHit} />}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
