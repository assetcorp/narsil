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
import { ensureThread, saveThreadMessages, setThreadTitle } from '../chat/store'
import { NarsilServerError } from '../narsil-server-client'
import type { RestBackend } from '../rest-backend'
import type { LlmProviderConfig } from './config'
import { type AskRequest, boundHistory, isFollowUp } from './messages'
import { answerInstructions } from './prompt'
import { RetrievalModeUnavailableError } from './retrieval'
import { generateThreadTitle } from './title'
import { createAskTools } from './tools'
import { type AskSource, type AskUIMessage, EMBEDDING_FIELD } from './types'

/**
 * Output ceiling for one answer. Reasoning models spend output tokens on
 * reasoning before the visible text, so the ceiling stays well above the
 * length of a long cited answer (~600 tokens) to avoid mid-answer cutoffs
 * while still bounding a runaway generation.
 */
const ANSWER_MAX_OUTPUT_TOKENS = 4096

/**
 * Ceiling on tool + answer steps: one search, several document reads, then the
 * written answer. The last step always forces the answer, so this only bounds
 * how many documents can be read.
 */
const MAX_STEPS = 8

/** Keeps the model's private reasoning short so the first tool call arrives
 * quickly; reading and citing, not deep reasoning, is the work here. */
const REASONING_EFFORT = 'low'

function askProvider(llm: LlmProviderConfig) {
  return createOpenAI({ apiKey: llm.apiKey, baseURL: llm.baseUrl })
}

/** Provider errors can echo credential fragments (OpenAI 401 bodies quote a
 * masked key); anything shaped like a secret is removed before the message
 * reaches the page. */
function redactSecrets(message: string): string {
  return message.replace(/\b(?:sk|rk)-[\w*.-]+/gi, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
}

/** Maps a failure to text safe to show in the chat. Narsil and configuration
 * errors carry actionable operator messages; provider messages are kept
 * because they explain setup mistakes, but only after secret redaction. */
function publicErrorMessage(err: unknown): string {
  if (err instanceof RetrievalModeUnavailableError || err instanceof NarsilServerError) {
    return err.message
  }
  if (err instanceof Error && err.message.length > 0 && err.message.length <= 600) {
    return redactSecrets(err.message)
  }
  return 'Something went wrong while answering. Check the app server logs and try again.'
}

const PROVISIONAL_TITLE_CHARS = 80

function provisionalTitle(question: string): string {
  const firstLine = question.split('\n', 1)[0].trim()
  const base = firstLine.length > 0 ? firstLine : question.trim()
  return base.slice(0, PROVISIONAL_TITLE_CHARS)
}

async function writeThreadTitle(
  writer: UIMessageStreamWriter<AskUIMessage>,
  model: LanguageModel,
  request: AskRequest,
  signal: AbortSignal,
): Promise<void> {
  if (isFollowUp(request.messages)) return
  const title = await generateThreadTitle(model, request.question, signal)
  if (title === null) return
  writer.write({ type: 'data-thread-title', id: 'thread-title', data: { threadId: request.threadId, title } })
  try {
    await setThreadTitle(request.threadId, title)
  } catch {}
}

export function createAskResponse(
  backend: RestBackend,
  llm: LlmProviderConfig,
  request: AskRequest,
  signal: AbortSignal,
): Response {
  const stream = createUIMessageStream<AskUIMessage>({
    onError: publicErrorMessage,
    originalMessages: request.messages as AskUIMessage[],
    onEnd: async ({ responseMessage }) => {
      const messages = [...(request.messages as AskUIMessage[]), responseMessage]
      try {
        await saveThreadMessages(request.threadId, request.indexName, messages, Date.now())
      } catch {}
    },
    execute: async ({ writer }) => {
      await ensureThread(request.threadId, request.indexName, provisionalTitle(request.question), Date.now())
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
            query: query.length > 0 ? query : request.question,
            elapsedMs,
            sources,
          },
        })
      }

      const provider = askProvider(llm)
      const titleTask = writeThreadTitle(writer, provider.chat(llm.titleModel), request, signal)
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
          // Force one search up front.
          if (stepNumber === 0) {
            return { toolChoice: { type: 'tool', toolName: 'search' }, activeTools: ['search'] }
          }
          // The final step always produces the written answer, so the loop can
          // never end on a tool call with nothing to show.
          if (stepNumber >= MAX_STEPS - 1) {
            return { toolChoice: 'none' }
          }
          // Nothing was retrieved: answer directly instead of reading.
          if (retrieval.candidateCount() === 0) {
            return { toolChoice: 'none' }
          }
          // Read candidates, no re-searching; the model reads what it needs
          // then answers when ready.
          return { activeTools: readingTools }
        },
        instructions: answerInstructions(request.indexName, request.webSearch),
        messages: await convertToModelMessages(boundHistory(request.messages)),
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
