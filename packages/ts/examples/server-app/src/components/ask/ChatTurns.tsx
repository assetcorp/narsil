import { BookOpen, Check, Copy, Globe, RefreshCcw, Search } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { MessageAction, MessageActions, MessageResponse, MessageToolbar } from '#/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '#/components/ai-elements/reasoning'
import { Source, Sources, SourcesContent, SourcesTrigger } from '#/components/ai-elements/sources'
import { Tool, ToolContent, ToolHeader } from '#/components/ai-elements/tool'
import { Bubble, BubbleContent } from '#/components/ui/bubble'
import { Marker, MarkerContent, MarkerIcon } from '#/components/ui/marker'
import { Message, MessageContent } from '#/components/ui/message'
import { Spinner } from '#/components/ui/spinner'
import { RETRIEVAL_MODE_OPTIONS, sourcesPartOf, textOf } from '#/lib/ask/client'
import {
  type AskReadInput,
  type AskSearchInput,
  type AskSource,
  type AskUIMessage,
  isAskReadError,
} from '#/lib/ask/types'
import { AnswerSourcesDisclosure, CitationChips } from './AnswerSources'

type AskMessagePart = AskUIMessage['parts'][number]
type SearchPart = Extract<AskMessagePart, { type: 'tool-search' }>
type ReadPart = Extract<AskMessagePart, { type: 'tool-readDocument' }>
type ReasoningPart = Extract<AskMessagePart, { type: 'reasoning' }>

const READ_PREVIEW_CHARS = 240

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

function SearchStep({ part }: { part: SearchPart }) {
  const input = part.input as AskSearchInput | undefined
  const query = input?.query
  const output = part.state === 'output-available' ? part.output : null
  const count = output?.results.length ?? 0

  const title = (
    <span>
      {query ? `Searched "${query}"` : 'Searching the index'}
      {output && (
        <span className="font-normal text-muted-foreground"> — {count === 1 ? '1 result' : `${count} results`}</span>
      )}
    </span>
  )

  return (
    <Tool>
      <ToolHeader state={part.state} icon={<Search className="size-4" />} title={title} />
      {output && output.results.length > 0 && (
        <ToolContent>
          <ul className="space-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
            {output.results.map(result => (
              <li key={result.docId} className="truncate">
                {result.title}
              </li>
            ))}
          </ul>
        </ToolContent>
      )}
    </Tool>
  )
}

function ReadStep({ part }: { part: ReadPart }) {
  const input = part.input as AskReadInput | undefined
  const output = part.state === 'output-available' ? part.output : null
  const errored = output && isAskReadError(output) ? output : null
  const page = output && !isAskReadError(output) ? output : null

  const title = page
    ? `Read ${page.title} (part ${page.page + 1}/${page.totalPages})`
    : errored
      ? "Couldn't open that document"
      : `Reading ${input?.docId ? `document ${input.docId}` : 'a document'}`

  const preview = page ? page.text.slice(0, READ_PREVIEW_CHARS).trim() : null

  return (
    <Tool>
      <ToolHeader state={part.state} icon={<BookOpen className="size-4" />} title={title} />
      {errored && (
        <ToolContent>
          <p className="border-t px-3 py-2 text-xs text-destructive">{errored.error}</p>
        </ToolContent>
      )}
      {preview && preview.length > 0 && (
        <ToolContent>
          <p className="border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            {preview}
            {page && page.text.length > READ_PREVIEW_CHARS ? '…' : ''}
          </p>
        </ToolContent>
      )}
    </Tool>
  )
}

function ReasoningStep({ part }: { part: ReasoningPart }) {
  if (part.text.length === 0) return null
  return (
    <Reasoning isStreaming={part.state === 'streaming'}>
      <ReasoningTrigger />
      <ReasoningContent>{part.text}</ReasoningContent>
    </Reasoning>
  )
}

function AssistantPart({ part }: { part: AskMessagePart }) {
  if (part.type === 'text') {
    return part.text.length > 0 ? <MessageResponse>{part.text}</MessageResponse> : null
  }
  if (part.type === 'reasoning') return <ReasoningStep part={part} />
  if (part.type === 'tool-search') return <SearchStep part={part} />
  if (part.type === 'tool-readDocument') return <ReadStep part={part} />
  return null
}

function hasVisiblePart(message: AskUIMessage): boolean {
  return message.parts.some(
    part =>
      (part.type === 'text' && part.text.length > 0) ||
      (part.type === 'reasoning' && part.text.length > 0) ||
      part.type === 'tool-search' ||
      part.type === 'tool-readDocument',
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
 * One agentic answer, rendered in the order it happened: each search and read
 * appears as a concise step card as the model works, then the markdown answer
 * with [n] citations, then the chips mapping those citations back to the
 * documents the agent opened.
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

        {message.parts.map((part, index) => (
          <AssistantPart key={`${part.type}-${index}`} part={part} />
        ))}

        {isStreaming && text.length === 0 && (
          <SearchingMarker phase="generating" indexName={retrieval?.indexName ?? ''} />
        )}

        {!isStreaming && !hasVisiblePart(message) && (
          <p className="text-sm text-muted-foreground">No answer was produced.</p>
        )}

        {retrieval && <AnswerSourcesDisclosure retrieval={retrieval} onOpenSource={onOpenSource} />}

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
