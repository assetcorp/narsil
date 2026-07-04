import { useCallback } from 'react'
import {
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationQuote,
  InlineCitationSource,
} from '#/components/ai-elements/inline-citation'
import { Sources, SourcesContent, SourcesTrigger } from '#/components/ai-elements/sources'
import { Badge } from '#/components/ui/badge'
import { HoverCardTrigger } from '#/components/ui/hover-card'
import type { AskSource, AskSourcesData } from '#/lib/ask/types'

function plainSnippet(snippet: string): string {
  return snippet
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

interface CitationChipProps {
  source: AskSource
  onOpen: (source: AskSource) => void
}

/**
 * Numbered citation chip matching the [n] markers in the answer text. Hover
 * previews the passage; click opens the full document.
 */
function CitationChip({ source, onOpen }: CitationChipProps) {
  const handleClick = useCallback(() => {
    onOpen(source)
  }, [onOpen, source])

  return (
    <InlineCitationCard>
      <HoverCardTrigger asChild>
        <button type="button" onClick={handleClick} className="cursor-pointer">
          <Badge variant="secondary" className="gap-1 rounded-full font-mono text-[10px] hover:bg-primary/15">
            [{source.rank}]<span className="max-w-32 truncate font-sans font-normal">{source.title}</span>
          </Badge>
        </button>
      </HoverCardTrigger>
      <InlineCitationCardBody className="p-4">
        <InlineCitationSource title={source.title}>
          <InlineCitationQuote>{plainSnippet(source.snippet)}</InlineCitationQuote>
          <p className="pt-1 font-mono text-[10px] text-muted-foreground">
            score {source.score.toFixed(3)} - {source.indexName}
          </p>
        </InlineCitationSource>
      </InlineCitationCardBody>
    </InlineCitationCard>
  )
}

interface CitationChipsProps {
  sources: AskSource[]
  onOpenSource: (source: AskSource) => void
}

export function CitationChips({ sources, onOpenSource }: CitationChipsProps) {
  if (sources.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sources.map(source => (
        <CitationChip key={source.docId} source={source} onOpen={onOpenSource} />
      ))}
    </div>
  )
}

interface SourceRowProps {
  source: AskSource
  onOpen: (source: AskSource) => void
}

function SourceRow({ source, onOpen }: SourceRowProps) {
  const handleClick = useCallback(() => {
    onOpen(source)
  }, [onOpen, source])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs hover:bg-muted/50"
    >
      <span className="font-mono text-[10px] text-primary">[{source.rank}]</span>
      <span className="truncate font-medium text-foreground">{source.title}</span>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{source.score.toFixed(3)}</span>
    </button>
  )
}

interface AnswerSourcesDisclosureProps {
  retrieval: AskSourcesData
  onOpenSource: (source: AskSource) => void
}

/**
 * Compact per-answer source list. The rail mirrors the latest answer; this
 * disclosure keeps every earlier answer's evidence reachable from history.
 */
export function AnswerSourcesDisclosure({ retrieval, onOpenSource }: AnswerSourcesDisclosureProps) {
  if (retrieval.sources.length === 0) return null
  return (
    <Sources className="mb-0">
      <SourcesTrigger count={retrieval.sources.length} className="cursor-pointer" />
      <SourcesContent className="w-full max-w-md">
        {retrieval.sources.map(source => (
          <SourceRow key={source.docId} source={source} onOpen={onOpenSource} />
        ))}
      </SourcesContent>
    </Sources>
  )
}
