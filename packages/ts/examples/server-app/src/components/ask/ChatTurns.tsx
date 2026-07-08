import { Check, Copy, Globe, RefreshCcw, Search } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { MessageAction, MessageActions, MessageResponse, MessageToolbar } from '#/components/ai-elements/message'
import { Source, Sources, SourcesContent, SourcesTrigger } from '#/components/ai-elements/sources'
import { Bubble, BubbleContent } from '#/components/ui/bubble'
import { Marker, MarkerContent, MarkerIcon } from '#/components/ui/marker'
import { Message, MessageContent } from '#/components/ui/message'
import { Spinner } from '#/components/ui/spinner'
import { RETRIEVAL_MODE_OPTIONS, sourcesPartOf, textOf } from '#/lib/ask/client'
import type { AskSource, AskUIMessage } from '#/lib/ask/types'
import { AnswerSourcesDisclosure, CitationChips } from './AnswerSources'

interface UserTurnProps {
  message: AskUIMessage
}

export const UserTurn = memo(function UserTurn({ message }: UserTurnProps) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble align="end" variant="secondary">
          <BubbleContent>{textOf(message)}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
})

interface SearchingMarkerProps {
  phase: 'searching' | 'generating'
  indexName: string
}

export function SearchingMarker({ phase, indexName }: SearchingMarkerProps) {
  return (
    <Marker>
      <MarkerIcon>{phase === 'searching' ? <Search /> : <Spinner />}</MarkerIcon>
      <MarkerContent>
        <span className="shimmer">
          {phase === 'searching' ? `Searching ${indexName}` : 'Writing a grounded answer'}
        </span>
      </MarkerContent>
    </Marker>
  )
}

function CopyAction({ message }: { message: AskUIMessage }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(textOf(message))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [message])

  return (
    <MessageAction tooltip="Copy answer" onClick={handleCopy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </MessageAction>
  )
}

function webSourceLabel(url: string, title?: string): string {
  if (title && title.length > 0) return title
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function WebSources({ message }: { message: AskUIMessage }) {
  const webSources = message.parts.flatMap(part => (part.type === 'source-url' ? [part] : []))
  if (webSources.length === 0) return null

  return (
    <Sources>
      <SourcesTrigger count={webSources.length}>
        <Globe className="size-3.5" />
        <p className="font-medium">
          {webSources.length} web {webSources.length === 1 ? 'result' : 'results'}
        </p>
      </SourcesTrigger>
      <SourcesContent>
        {webSources.map(part => (
          <Source key={part.sourceId} href={part.url} title={webSourceLabel(part.url, part.title)} />
        ))}
      </SourcesContent>
    </Sources>
  )
}

interface AssistantTurnProps {
  message: AskUIMessage
  isLast: boolean
  isStreaming: boolean
  onOpenSource: (source: AskSource) => void
  onRegenerate: () => void
}

/**
 * One grounded answer: the retrieval evidence first (it streams in before the
 * first token), then the markdown answer with [n] citations, then the chips
 * mapping those citations back to documents.
 */
export const AssistantTurn = memo(function AssistantTurn({
  message,
  isLast,
  isStreaming,
  onOpenSource,
  onRegenerate,
}: AssistantTurnProps) {
  const retrieval = sourcesPartOf(message)
  const text = textOf(message)
  const modeLabel = retrieval
    ? (RETRIEVAL_MODE_OPTIONS.find(option => option.id === retrieval.mode)?.label ?? retrieval.mode)
    : null

  return (
    <Message>
      <MessageContent>
        {retrieval && modeLabel && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{modeLabel}</span>
            <span className="font-mono">{retrieval.elapsedMs.toFixed(1)}ms retrieval</span>
          </div>
        )}

        {retrieval && <AnswerSourcesDisclosure retrieval={retrieval} onOpenSource={onOpenSource} />}

        {text.length > 0 ? (
          <MessageResponse>{text}</MessageResponse>
        ) : (
          isStreaming && <SearchingMarker phase="generating" indexName={retrieval?.indexName ?? ''} />
        )}

        {retrieval && text.length > 0 && <CitationChips sources={retrieval.sources} onOpenSource={onOpenSource} />}

        {text.length > 0 && <WebSources message={message} />}

        {text.length > 0 && !isStreaming && (
          <MessageToolbar className="mt-0">
            <MessageActions>
              <CopyAction message={message} />
              {isLast && (
                <MessageAction tooltip="Ask again with current mode" onClick={onRegenerate}>
                  <RefreshCcw className="size-3.5" />
                </MessageAction>
              )}
            </MessageActions>
          </MessageToolbar>
        )}
      </MessageContent>
    </Message>
  )
})
