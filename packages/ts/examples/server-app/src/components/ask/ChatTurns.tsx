import { BookOpen, Check, Copy, Globe, RefreshCcw, Search } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { getUsage } from 'tokenlens'
import { openaiModels } from 'tokenlens/providers/openai'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '#/components/ai-elements/chain-of-thought'
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from '#/components/ai-elements/context'
import { MessageAction, MessageActions, MessageResponse, MessageToolbar } from '#/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '#/components/ai-elements/reasoning'
import { Source, Sources, SourcesContent, SourcesTrigger } from '#/components/ai-elements/sources'
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
type ToolPart = SearchPart | ReadPart
type StepStatus = 'complete' | 'active' | 'pending'

const READ_PREVIEW_CHARS = 240
const DEFAULT_CONTEXT_TOKENS = 128_000

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

function toolStatus(part: ToolPart, isStreaming: boolean): StepStatus {
  if (part.state === 'output-available' || part.state === 'output-error') return 'complete'
  return isStreaming ? 'active' : 'pending'
}

function SearchTraceStep({ part, isStreaming }: { part: SearchPart; isStreaming: boolean }) {
  const input = part.input as AskSearchInput | undefined
  const query = input?.query
  const output = part.state === 'output-available' ? part.output : null
  const status = toolStatus(part, isStreaming)
  const results = output?.results ?? []

  const label = output
    ? `Searched ${query ? `“${query}”` : 'the index'} — ${results.length === 1 ? '1 result' : `${results.length} results`}`
    : query
      ? `Searching “${query}”`
      : 'Searching the index'

  return (
    <ChainOfThoughtStep icon={Search} label={label} status={status}>
      {results.length > 0 && (
        <ChainOfThoughtSearchResults>
          {results.map(result => (
            <ChainOfThoughtSearchResult key={result.docId}>{result.title}</ChainOfThoughtSearchResult>
          ))}
        </ChainOfThoughtSearchResults>
      )}
    </ChainOfThoughtStep>
  )
}

function ReadTraceStep({ part, isStreaming }: { part: ReadPart; isStreaming: boolean }) {
  const input = part.input as AskReadInput | undefined
  const output = part.state === 'output-available' ? part.output : null
  const errored = output && isAskReadError(output) ? output : null
  const page = output && !isAskReadError(output) ? output : null
  const status = toolStatus(part, isStreaming)

  const label = page
    ? `Read ${page.title} · part ${page.page + 1}/${page.totalPages}`
    : errored
      ? "Couldn't open that document"
      : `Reading ${input?.docId ? `document ${input.docId}` : 'a document'}`

  const description = errored
    ? errored.error
    : page
      ? `${page.text.slice(0, READ_PREVIEW_CHARS).trim()}${page.text.length > READ_PREVIEW_CHARS ? '…' : ''}`
      : undefined

  return <ChainOfThoughtStep icon={BookOpen} label={label} description={description} status={status} />
}

function AgentTrace({ toolParts, isStreaming }: { toolParts: ToolPart[]; isStreaming: boolean }) {
  const [open, setOpen] = useState(false)
  const summary = isStreaming
    ? 'Working through the index'
    : `Worked through ${toolParts.length} ${toolParts.length === 1 ? 'step' : 'steps'}`

  return (
    <ChainOfThought open={open || isStreaming} onOpenChange={setOpen}>
      <ChainOfThoughtHeader>{summary}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {toolParts.map(part =>
          part.type === 'tool-search' ? (
            <SearchTraceStep key={part.toolCallId} part={part} isStreaming={isStreaming} />
          ) : (
            <ReadTraceStep key={part.toolCallId} part={part} isStreaming={isStreaming} />
          ),
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  )
}

function contextWindowFor(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_TOKENS
  const context = getUsage({ modelId, usage: { input: 0, output: 0 }, providers: openaiModels }).context
  return context?.combinedMax ?? context?.totalMax ?? DEFAULT_CONTEXT_TOKENS
}

function ContextChip({ message }: { message: AskUIMessage }) {
  const usage = message.metadata?.usage
  const modelId = message.metadata?.modelId
  const usedTokens = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  if (!usage || usedTokens === 0) return null

  return (
    <Context usedTokens={usedTokens} maxTokens={contextWindowFor(modelId)} usage={usage} modelId={modelId}>
      <ContextTrigger className="h-8 gap-1.5 px-2 text-xs" />
      <ContextContent>
        <ContextContentHeader />
        <ContextContentBody>
          <ContextInputUsage />
          <ContextOutputUsage />
          <ContextReasoningUsage />
          <ContextCacheUsage />
        </ContextContentBody>
        <ContextContentFooter />
      </ContextContent>
    </Context>
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
 * One agentic answer. The model's private thinking is consolidated into a single
 * Reasoning block, every search and document read becomes a labeled step in a
 * Chain of Thought trace, then the markdown answer with [n] citations, the chips
 * mapping those citations back to the opened documents, and a Context chip
 * reporting how much of the model's window the answer consumed.
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

  const reasoningText = useMemo(
    () =>
      message.parts
        .flatMap(part => (part.type === 'reasoning' ? [part.text] : []))
        .join('\n\n')
        .trim(),
    [message.parts],
  )
  const lastPart = message.parts.at(-1)
  const isReasoningStreaming = isStreaming && lastPart?.type === 'reasoning'

  const toolParts = useMemo(
    () =>
      message.parts.filter(
        (part): part is ToolPart => part.type === 'tool-search' || part.type === 'tool-readDocument',
      ),
    [message.parts],
  )

  const hasVisiblePart = text.length > 0 || reasoningText.length > 0 || toolParts.length > 0

  return (
    <Message>
      <MessageContent>
        {retrieval && modeLabel && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{modeLabel}</span>
            <span className="font-mono">{retrieval.elapsedMs.toFixed(1)}ms retrieval</span>
          </div>
        )}

        {reasoningText.length > 0 && (
          <Reasoning isStreaming={isReasoningStreaming}>
            <ReasoningTrigger />
            <ReasoningContent>{reasoningText}</ReasoningContent>
          </Reasoning>
        )}

        {toolParts.length > 0 && <AgentTrace toolParts={toolParts} isStreaming={isStreaming} />}

        {text.length > 0 && <MessageResponse>{text}</MessageResponse>}

        {isStreaming && text.length === 0 && (
          <SearchingMarker phase="generating" indexName={retrieval?.indexName ?? ''} />
        )}

        {!isStreaming && !hasVisiblePart && <p className="text-sm text-muted-foreground">No answer was produced.</p>}

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
            <ContextChip message={message} />
          </MessageToolbar>
        )}
      </MessageContent>
    </Message>
  )
})
