import { useChat } from '@ai-sdk/react'
import type { LoadedIndex } from '@delali/narsil-example-shared'
import { useAppDispatch, useAppState } from '@delali/narsil-example-shared'
import { DefaultChatTransport } from 'ai'
import { MessagesSquare, Plus, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Suggestion } from '#/components/ai-elements/suggestion'
import { Button } from '#/components/ui/button'
import { Marker, MarkerContent, MarkerIcon } from '#/components/ui/marker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '#/components/ui/message-scroller'
import { sourcesPartOf, suggestionsForDataset } from '#/lib/ask/client'
import {
  type AskCapabilities,
  type AskSource,
  type AskUIMessage,
  EMBEDDING_FIELD,
  type RetrievalMode,
} from '#/lib/ask/types'
import { askCapabilitiesFn, getStatsFn } from '#/lib/server-fns'
import { AskPromptInput } from './AskPromptInput'
import { AssistantTurn, SearchingMarker, UserTurn } from './ChatTurns'
import { ModeToggle } from './ModeToggle'
import { SetupNotice } from './SetupNotice'
import { SourceDocumentSheet } from './SourceDocumentSheet'
import { SourcesRail } from './SourcesRail'

function vectorModesDisabledReason(
  capabilities: AskCapabilities | null,
  indexHasVectors: boolean | null,
): string | null {
  if (capabilities && !capabilities.embeddingsConfigured) {
    return 'Semantic and hybrid modes need an embedding provider. Set OPENAI_API_KEY (or ASK_EMBEDDING_API_KEY), restart, and reload the dataset.'
  }
  if (indexHasVectors === false) {
    return 'This index was loaded without embeddings. Remove it and load the dataset again to embed its documents.'
  }
  if (indexHasVectors === null) {
    return 'Checking whether this index has embeddings...'
  }
  return null
}

interface HeroHeadingProps {
  index: LoadedIndex
}

function HeroHeading({ index }: HeroHeadingProps) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
        <MessagesSquare className="size-6 text-primary" />
      </div>
      <div className="space-y-2">
        <h2 className="font-serif text-3xl tracking-tight text-balance sm:text-4xl">Ask {index.name}</h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
          Answers come only from the {index.documentCount.toLocaleString()} documents in this index, with the retrieved
          passages shown beside every answer. Switch retrieval modes to watch the same question pull different evidence.
        </p>
      </div>
    </div>
  )
}

interface HeroSuggestionsProps {
  index: LoadedIndex
  disabled: boolean
  onSuggestion: (text: string) => void
}

function HeroSuggestions({ index, disabled, onSuggestion }: HeroSuggestionsProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {suggestionsForDataset(index.datasetId).map(text => (
        <Suggestion
          key={text}
          suggestion={text}
          onClick={onSuggestion}
          disabled={disabled}
          className="h-auto whitespace-normal py-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
        />
      ))}
    </div>
  )
}

export function AskView() {
  const state = useAppState()
  const dispatch = useAppDispatch()

  const indexes = useMemo(() => state.indexes.filter(index => index.documentCount > 0), [state.indexes])
  const activeFromState = state.activeIndexName
  const indexName = useMemo(() => {
    if (activeFromState && indexes.some(index => index.name === activeFromState)) return activeFromState
    return indexes[0]?.name ?? null
  }, [activeFromState, indexes])
  const selectedIndex = indexes.find(index => index.name === indexName) ?? null

  const [mode, setMode] = useState<RetrievalMode>('keyword')
  const userChoseMode = useRef(false)
  const [capabilities, setCapabilities] = useState<AskCapabilities | null>(null)
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)
  const [vectorReadyByIndex, setVectorReadyByIndex] = useState<Record<string, boolean>>({})
  const [phase, setPhase] = useState<'searching' | 'generating' | null>(null)
  const [openSource, setOpenSource] = useState<AskSource | null>(null)

  const indexNameRef = useRef(indexName)
  const modeRef = useRef(mode)
  useEffect(() => {
    indexNameRef.current = indexName
  }, [indexName])
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    let cancelled = false
    askCapabilitiesFn()
      .then(result => {
        if (!cancelled) setCapabilities(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setCapabilitiesError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!indexName || indexName in vectorReadyByIndex) return
    let cancelled = false
    getStatsFn({ data: { indexName } })
      .then(stats => {
        if (cancelled) return
        const hasVectors = EMBEDDING_FIELD in (stats.schema as Record<string, unknown>)
        setVectorReadyByIndex(prev => ({ ...prev, [indexName]: hasVectors }))
      })
      .catch(() => {
        if (!cancelled) setVectorReadyByIndex(prev => ({ ...prev, [indexName]: false }))
      })
    return () => {
      cancelled = true
    }
  }, [indexName, vectorReadyByIndex])

  const indexHasVectors = indexName ? (vectorReadyByIndex[indexName] ?? null) : null
  const disabledReason = vectorModesDisabledReason(capabilities, indexHasVectors)

  useEffect(() => {
    if (disabledReason && mode !== 'keyword') {
      setMode('keyword')
      return
    }
    if (!disabledReason && !userChoseMode.current && mode === 'keyword') {
      setMode('hybrid')
    }
  }, [disabledReason, mode])

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/ask',
        body: () => ({ indexName: indexNameRef.current, mode: modeRef.current }),
      }),
    [],
  )

  const handleData = useCallback((dataPart: { type: string; data: unknown }) => {
    if (dataPart.type === 'data-ask-status') {
      setPhase((dataPart.data as { phase: 'searching' | 'generating' }).phase)
    }
  }, [])

  const { messages, status, error, sendMessage, stop, regenerate, setMessages, clearError } = useChat<AskUIMessage>({
    transport,
    onData: handleData,
  })

  useEffect(() => {
    if (status === 'ready' || status === 'error') setPhase(null)
  }, [status])

  const handleModeChange = useCallback((next: RetrievalMode) => {
    userChoseMode.current = true
    setMode(next)
  }, [])

  const handleIndexChange = useCallback(
    (name: string) => {
      dispatch({ type: 'SET_ACTIVE_INDEX', payload: name })
    },
    [dispatch],
  )

  const handleSubmitText = useCallback(
    (text: string) => {
      void sendMessage({ text })
    },
    [sendMessage],
  )

  const handleRegenerate = useCallback(() => {
    void regenerate()
  }, [regenerate])

  const handleRetry = useCallback(() => {
    clearError()
    void regenerate()
  }, [clearError, regenerate])

  const handleNewChat = useCallback(() => {
    stop()
    clearError()
    setMessages([])
  }, [stop, clearError, setMessages])

  const handleCloseSource = useCallback(() => {
    setOpenSource(null)
  }, [])

  const latestRetrieval = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      const retrieval = sourcesPartOf(message)
      if (retrieval) return retrieval
    }
    return null
  }, [messages])

  const isBusy = status === 'submitted' || status === 'streaming'
  const lastMessage = messages[messages.length - 1]
  const awaitingAssistant = status === 'submitted' && lastMessage?.role !== 'assistant'
  const inputDisabled = capabilities !== null && !capabilities.llmConfigured

  if (!selectedIndex || !indexName) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-2 font-serif text-3xl tracking-tight">Ask</h1>
        <p className="text-sm text-muted-foreground">Load a dataset from the Datasets tab to ask questions about it.</p>
      </div>
    )
  }

  const hasConversation = messages.length > 0

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] max-w-6xl flex-col px-4 pt-5 pb-4">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pb-4">
        <div>
          <h1 className="font-serif text-2xl tracking-tight">Ask</h1>
          <p className="text-xs text-muted-foreground">
            Grounded answers with receipts, straight from <span className="font-mono">{indexName}</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ModeToggle mode={mode} onModeChange={handleModeChange} vectorModesDisabledReason={disabledReason} />
          {hasConversation && (
            <Button type="button" variant="outline" size="sm" onClick={handleNewChat}>
              <Plus className="size-3.5" />
              New chat
            </Button>
          )}
        </div>
      </div>

      {hasConversation ? (
        <div className="grid min-h-0 min-w-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <section className="flex min-h-0 min-w-0 flex-col">
            <MessageScrollerProvider autoScroll>
              <MessageScroller className="flex-1">
                <MessageScrollerViewport>
                  <MessageScrollerContent className="mx-auto w-full max-w-3xl px-1.5 py-6">
                    {messages.map((message, i) =>
                      message.role === 'user' ? (
                        <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor>
                          <UserTurn message={message} />
                        </MessageScrollerItem>
                      ) : (
                        <MessageScrollerItem key={message.id} messageId={message.id}>
                          <AssistantTurn
                            message={message}
                            isLast={i === messages.length - 1}
                            isStreaming={isBusy && i === messages.length - 1}
                            onOpenSource={setOpenSource}
                            onRegenerate={handleRegenerate}
                          />
                        </MessageScrollerItem>
                      ),
                    )}
                    {awaitingAssistant && (
                      <MessageScrollerItem messageId="pending-answer">
                        <SearchingMarker phase={phase ?? 'searching'} indexName={indexName} />
                      </MessageScrollerItem>
                    )}
                    {error && (
                      <MessageScrollerItem messageId="answer-error">
                        <Marker variant="border" className="border-destructive/40 text-destructive">
                          <MarkerIcon>
                            <TriangleAlert />
                          </MarkerIcon>
                          <MarkerContent>{error.message}</MarkerContent>
                          <Button type="button" variant="outline" size="xs" onClick={handleRetry}>
                            Retry
                          </Button>
                        </Marker>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>

            <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-3 pt-3">
              <SetupNotice capabilities={capabilities} capabilitiesError={capabilitiesError} />
              <AskPromptInput
                indexes={indexes}
                indexName={indexName}
                onIndexChange={handleIndexChange}
                status={status}
                disabled={inputDisabled}
                onSubmitText={handleSubmitText}
                onStop={stop}
              />
            </div>
          </section>

          <div className="hidden min-h-0 lg:block">
            <SourcesRail retrieval={latestRetrieval} onOpenSource={setOpenSource} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="m-auto flex w-full max-w-2xl flex-col gap-7 py-8 lg:pb-16">
            <HeroHeading index={selectedIndex} />
            <div className="flex flex-col gap-3">
              <SetupNotice capabilities={capabilities} capabilitiesError={capabilitiesError} />
              <AskPromptInput
                indexes={indexes}
                indexName={indexName}
                onIndexChange={handleIndexChange}
                status={status}
                disabled={inputDisabled}
                onSubmitText={handleSubmitText}
                onStop={stop}
              />
            </div>
            <HeroSuggestions index={selectedIndex} disabled={inputDisabled} onSuggestion={handleSubmitText} />
          </div>
        </div>
      )}

      <SourceDocumentSheet source={openSource} onClose={handleCloseSource} />
    </div>
  )
}
