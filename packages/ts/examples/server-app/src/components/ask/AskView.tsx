import { useChat } from '@ai-sdk/react'
import { useAppDispatch, useAppState } from '@delali/narsil-example-shared'
import { DefaultChatTransport } from 'ai'
import { TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { sourcesPartOf, threadTitlePartOf, vectorModesDisabledReason } from '#/lib/ask/client'
import { provisionalTitle } from '#/lib/ask/title'
import {
  type AskCapabilities,
  type AskSource,
  type AskUIMessage,
  EMBEDDING_FIELD,
  type RetrievalMode,
} from '#/lib/ask/types'
import { askCapabilitiesFn, getStatsFn } from '#/lib/server-fns'
import { HeroHeading, HeroSuggestions } from './AskHero'
import { SourcesSheet, ThreadsSheet } from './AskMobilePanels'
import { AskPromptInput } from './AskPromptInput'
import { AssistantTurn, SearchingMarker, UserTurn } from './ChatTurns'
import { ModeToggle } from './ModeToggle'
import { SetupNotice } from './SetupNotice'
import { SourceDocumentSheet } from './SourceDocumentSheet'
import { SourcesRail } from './SourcesRail'
import { ThreadSidebar } from './ThreadSidebar'
import { useAskThreads } from './use-ask-threads'

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
  const [webSearch, setWebSearch] = useState(false)
  const [capabilities, setCapabilities] = useState<AskCapabilities | null>(null)
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null)
  const [vectorReadyByIndex, setVectorReadyByIndex] = useState<Record<string, boolean>>({})
  const [openSource, setOpenSource] = useState<AskSource | null>(null)

  const {
    threads,
    activeThreadId,
    threadIdRef,
    setActiveThreadId,
    ensureThreadId,
    beginThread,
    isThreadNew,
    refresh,
    applyTitle,
    loadThread,
    removeThread,
  } = useAskThreads()

  const indexNameRef = useRef(indexName)
  const modeRef = useRef(mode)
  const webSearchRef = useRef(webSearch)
  useEffect(() => {
    indexNameRef.current = indexName
  }, [indexName])
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  useEffect(() => {
    webSearchRef.current = webSearch
  }, [webSearch])

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
      new DefaultChatTransport<AskUIMessage>({
        api: '/api/ask',
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
          body: {
            indexName: indexNameRef.current,
            mode: modeRef.current,
            webSearch: webSearchRef.current,
            threadId: threadIdRef.current,
            trigger,
            messageId,
            message: trigger === 'submit-message' ? messages[messages.length - 1] : undefined,
          },
        }),
      }),
    [threadIdRef],
  )

  const { messages, status, error, sendMessage, stop, regenerate, setMessages, clearError } = useChat<AskUIMessage>({
    transport,
    onFinish: refresh,
  })

  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return
    const titlePart = threadTitlePartOf(last)
    if (titlePart) applyTitle(titlePart.threadId, titlePart.title)
  }, [messages, applyTitle])

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
      const threadId = ensureThreadId()
      const currentIndexName = indexNameRef.current
      if (currentIndexName) beginThread(threadId, provisionalTitle(text), currentIndexName)
      void sendMessage({ text })
    },
    [ensureThreadId, beginThread, sendMessage],
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
    setActiveThreadId(null)
  }, [stop, clearError, setMessages, setActiveThreadId])

  const handleSelectThread = useCallback(
    async (id: string) => {
      if (id === threadIdRef.current) return
      stop()
      clearError()
      const thread = await loadThread(id)
      if (!thread) return
      setActiveThreadId(id)
      setMessages(thread.messages)
      if (thread.indexName !== indexNameRef.current) {
        dispatch({ type: 'SET_ACTIVE_INDEX', payload: thread.indexName })
      }
    },
    [stop, clearError, loadThread, setActiveThreadId, setMessages, dispatch, threadIdRef],
  )

  const handleDeleteThread = useCallback(
    async (id: string) => {
      await removeThread(id)
      if (id === threadIdRef.current) {
        stop()
        clearError()
        setMessages([])
        setActiveThreadId(null)
      }
    },
    [removeThread, stop, clearError, setMessages, setActiveThreadId, threadIdRef],
  )

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
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] max-w-6xl gap-4 px-4 pt-5 pb-4">
      <div className="hidden w-60 shrink-0 lg:flex lg:flex-col">
        <ThreadSidebar
          threads={threads}
          activeThreadId={activeThreadId}
          isThreadNew={isThreadNew}
          onSelect={handleSelectThread}
          onNew={handleNewChat}
          onDelete={handleDeleteThread}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pb-4">
          <div>
            <h1 className="font-serif text-2xl tracking-tight">Ask</h1>
            <p className="text-xs text-muted-foreground">
              Grounded answers with receipts, straight from <span className="font-mono">{indexName}</span>.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ModeToggle mode={mode} onModeChange={handleModeChange} vectorModesDisabledReason={disabledReason} />
            <ThreadsSheet
              threads={threads}
              activeThreadId={activeThreadId}
              isThreadNew={isThreadNew}
              onSelect={handleSelectThread}
              onNew={handleNewChat}
              onDelete={handleDeleteThread}
            />
            {hasConversation && <SourcesSheet retrieval={latestRetrieval} onOpenSource={setOpenSource} />}
          </div>
        </div>

        {hasConversation ? (
          <div className="grid min-h-0 min-w-0 flex-1 gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
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
                          <SearchingMarker phase="searching" indexName={indexName} />
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
                  webSearch={webSearch}
                  onWebSearchChange={setWebSearch}
                  onSubmitText={handleSubmitText}
                  onStop={stop}
                />
              </div>
            </section>

            <div className="hidden min-h-0 xl:block">
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
                  webSearch={webSearch}
                  onWebSearchChange={setWebSearch}
                  onSubmitText={handleSubmitText}
                  onStop={stop}
                />
              </div>
              <HeroSuggestions index={selectedIndex} disabled={inputDisabled} onSuggestion={handleSubmitText} />
            </div>
          </div>
        )}
      </div>

      <SourceDocumentSheet source={openSource} onClose={handleCloseSource} />
    </div>
  )
}
