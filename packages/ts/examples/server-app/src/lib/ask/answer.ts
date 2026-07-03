import { createOpenAI } from '@ai-sdk/openai'
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  streamText,
  toUIMessageStream,
  type UIMessageStreamWriter,
} from 'ai'
import { NarsilServerError } from '../narsil-server-client'
import type { RestBackend } from '../rest-backend'
import type { LlmProviderConfig } from './config'
import { type AskRequest, boundHistory, isFollowUp, MAX_QUESTION_CHARS } from './messages'
import { answerInstructions, QUERY_REWRITE_INSTRUCTIONS } from './prompt'
import { RetrievalModeUnavailableError, retrieveSources } from './retrieval'
import type { AskUIMessage } from './types'

const REWRITE_TIMEOUT_MS = 4000
const REWRITE_MAX_OUTPUT_TOKENS = 512

/**
 * Output ceiling for one answer. Reasoning models spend output tokens on
 * reasoning before the visible text, so the ceiling stays well above the
 * length of a long cited answer (~600 tokens) to avoid mid-answer cutoffs
 * while still bounding a runaway generation.
 */
const ANSWER_MAX_OUTPUT_TOKENS = 4096

function chatModel(llm: LlmProviderConfig) {
  const provider = createOpenAI({ apiKey: llm.apiKey, baseURL: llm.baseUrl })
  return provider.chat(llm.model)
}

/**
 * A follow-up like "who directed it?" retrieves poorly as-is, so the model
 * first rewrites it into a standalone search query using the conversation
 * (the pattern Typesense and Orama run server-side). The rewrite is bounded
 * by a timeout and falls back to the raw question text; only a client abort
 * propagates.
 */
async function resolveRetrievalQuery(
  llm: LlmProviderConfig,
  request: AskRequest,
  signal: AbortSignal,
): Promise<string> {
  if (!isFollowUp(request.messages)) return request.question

  try {
    const rewritten = await generateText({
      model: chatModel(llm),
      instructions: QUERY_REWRITE_INSTRUCTIONS,
      messages: await convertToModelMessages(boundHistory(request.messages)),
      maxOutputTokens: REWRITE_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(REWRITE_TIMEOUT_MS)]),
      providerOptions: { openai: { reasoningEffort: 'minimal' } },
    })
    const query = rewritten.text.replace(/\s+/g, ' ').trim()
    if (query.length > 0 && query.length <= MAX_QUESTION_CHARS) return query
    return request.question
  } catch (err) {
    if (signal.aborted) throw err
    return request.question
  }
}

function noSourcesMessage(request: AskRequest): string {
  return (
    `I searched the "${request.indexName}" index in ${request.mode} mode and found nothing relevant to that question. ` +
    'Try rephrasing it, switching the retrieval mode, or asking about something else in this dataset.'
  )
}

function writeAssistantText(writer: UIMessageStreamWriter<AskUIMessage>, id: string, text: string): void {
  writer.write({ type: 'text-start', id })
  writer.write({ type: 'text-delta', id, delta: text })
  writer.write({ type: 'text-end', id })
}

/** Maps a failure to text safe to show in the chat. Narsil and configuration
 * errors carry actionable operator messages; anything else stays generic so
 * provider internals never reach the page. */
function publicErrorMessage(err: unknown): string {
  if (err instanceof RetrievalModeUnavailableError || err instanceof NarsilServerError) {
    return err.message
  }
  if (err instanceof Error && err.message.length > 0 && err.message.length <= 600) {
    return err.message
  }
  return 'Something went wrong while answering. Check the app server logs and try again.'
}

export function createAskResponse(
  backend: RestBackend,
  llm: LlmProviderConfig,
  request: AskRequest,
  signal: AbortSignal,
): Response {
  const stream = createUIMessageStream<AskUIMessage>({
    onError: publicErrorMessage,
    execute: async ({ writer }) => {
      writer.write({ type: 'data-ask-status', data: { phase: 'searching' }, transient: true })

      const query = await resolveRetrievalQuery(llm, request, signal)
      const retrieval = await retrieveSources(backend, {
        indexName: request.indexName,
        mode: request.mode,
        query,
        signal,
      })

      const sources = retrieval.sources.map(({ passage: _passage, ...source }) => source)
      writer.write({
        type: 'data-ask-sources',
        id: 'sources',
        data: {
          mode: request.mode,
          indexName: request.indexName,
          query,
          elapsedMs: retrieval.elapsedMs,
          sources,
        },
      })

      if (retrieval.sources.length === 0) {
        writeAssistantText(writer, crypto.randomUUID(), noSourcesMessage(request))
        return
      }

      writer.write({ type: 'data-ask-status', data: { phase: 'generating' }, transient: true })

      const answer = streamText({
        model: chatModel(llm),
        instructions: answerInstructions(request.indexName, retrieval.sources),
        messages: await convertToModelMessages(boundHistory(request.messages)),
        maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
        abortSignal: signal,
      })

      writer.merge(toUIMessageStream({ stream: answer.stream }))
    },
  })

  return createUIMessageStreamResponse({ stream, consumeSseStream: consumeStream })
}
