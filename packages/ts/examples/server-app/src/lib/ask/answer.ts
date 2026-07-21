import { createOpenAI } from '@ai-sdk/openai'
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type LanguageModel,
  stepCountIs,
  streamText,
  type ToolSet,
  toUIMessageStream,
  type UIMessageStreamWriter,
} from 'ai'
import { saveTurn, setThreadTitle } from '../chat/store'
import { NarsilServerError } from '../narsil-server-client'
import type { RestBackend } from '../rest-backend'
import type { LlmProviderConfig } from './config'
import type { AskTurn } from './history'
import { type AskRequest, boundHistory } from './messages'
import { answerInstructions } from './prompt'
import { RetrievalModeUnavailableError } from './retrieval'
import { generateThreadTitle, provisionalTitle } from './title'
import { createAskTools } from './tools'
import { type AskSource, type AskUIMessage, EMBEDDING_FIELD } from './types'

const ANSWER_MAX_OUTPUT_TOKENS = 4096

const MAX_STEPS = 8

const REASONING_EFFORT = 'low'

function askProvider(llm: LlmProviderConfig) {
  return createOpenAI({ apiKey: llm.apiKey, baseURL: llm.baseUrl })
}

function redactSecrets(message: string): string {
  return message.replace(/\b(?:sk|rk)-[\w*.-]+/gi, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
}

function publicErrorMessage(err: unknown): string {
  if (err instanceof RetrievalModeUnavailableError || err instanceof NarsilServerError) {
    return err.message
  }
  if (err instanceof Error && err.message.length > 0 && err.message.length <= 600) {
    return redactSecrets(err.message)
  }
  return 'Something went wrong while answering. Check the app server logs and try again.'
}

function hasAnswerContent(message: AskUIMessage): boolean {
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.trim().length > 0) return true
  }
  return false
}

async function writeThreadTitle(
  writer: UIMessageStreamWriter<AskUIMessage>,
  model: LanguageModel,
  request: AskRequest,
  turn: AskTurn,
  signal: AbortSignal,
): Promise<void> {
  if (!turn.firstTurn) return
  const title = await generateThreadTitle(model, turn.question, signal)
  if (title === null) return
  writer.write({ type: 'data-thread-title', id: 'thread-title', data: { threadId: request.threadId, title } })
  try {
    await setThreadTitle(request.threadId, title)
  } catch (error) {
    console.error(`[ask] failed to store the title for thread ${request.threadId}:`, error)
  }
}

export function createAskResponse(
  backend: RestBackend,
  llm: LlmProviderConfig,
  request: AskRequest,
  turn: AskTurn,
  signal: AbortSignal,
): Response {
  const stream = createUIMessageStream<AskUIMessage>({
    onError: publicErrorMessage,
    originalMessages: turn.history,
    generateId: () => crypto.randomUUID(),
    onEnd: async ({ responseMessage }) => {
      if (!hasAnswerContent(responseMessage)) return
      try {
        await saveTurn({
          threadId: request.threadId,
          indexName: request.indexName,
          title: provisionalTitle(turn.question),
          expectedCount: turn.history.length,
          keepCount: turn.history.length,
          messages: [responseMessage],
          now: Date.now(),
        })
      } catch (error) {
        console.error(`[ask] failed to store the answer for thread ${request.threadId}:`, error)
      }
    },
    execute: async ({ writer }) => {
      if (request.mode !== 'keyword') {
        const stats = await backend.getStats(request.indexName)
        if (!(EMBEDDING_FIELD in (stats.schema as Record<string, unknown>))) {
          throw new RetrievalModeUnavailableError(request.mode, request.indexName)
        }
      }

      const emitSources = (sources: AskSource[], elapsedMs: number, query: string): void => {
        writer.write({
          type: 'data-ask-sources',
          id: 'sources',
          data: {
            mode: request.mode,
            indexName: request.indexName,
            query: query.length > 0 ? query : turn.question,
            elapsedMs,
            sources,
          },
        })
      }

      const provider = askProvider(llm)
      const titleTask = writeThreadTitle(writer, provider.chat(llm.titleModel), request, turn, signal)
      const retrieval = createAskTools({
        backend,
        indexName: request.indexName,
        mode: request.mode,
        signal,
        onOpen: emitSources,
      })
      const tools: ToolSet = request.webSearch
        ? { ...retrieval.tools, web_search: provider.tools.webSearch({}) }
        : retrieval.tools
      const readingTools = request.webSearch ? ['readDocument', 'web_search'] : ['readDocument']

      const answer = streamText({
        model: request.webSearch ? provider.responses(llm.model) : provider.chat(llm.model),
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        prepareStep: ({ stepNumber }) => {
          if (stepNumber === 0) {
            return { toolChoice: { type: 'tool', toolName: 'search' }, activeTools: ['search'] }
          }
          if (stepNumber >= MAX_STEPS - 1) {
            return { toolChoice: 'none' }
          }
          if (retrieval.candidateCount() === 0) {
            return { toolChoice: 'none' }
          }
          return { activeTools: readingTools }
        },
        instructions: answerInstructions(request.indexName, request.webSearch),
        messages: await convertToModelMessages(boundHistory(turn.history)),
        maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
        providerOptions: {
          openai: request.webSearch
            ? { reasoningEffort: REASONING_EFFORT, reasoningSummary: 'auto' }
            : { reasoningEffort: REASONING_EFFORT },
        },
        abortSignal: signal,
      })

      writer.merge(
        toUIMessageStream({
          stream: answer.stream,
          sendReasoning: true,
          sendSources: request.webSearch,
          messageMetadata: ({ part }) =>
            part.type === 'finish' ? { usage: part.totalUsage, modelId: `openai:${llm.model}` } : undefined,
        }),
      )

      await titleTask
    },
  })

  return createUIMessageStreamResponse({ stream, consumeSseStream: consumeStream })
}
