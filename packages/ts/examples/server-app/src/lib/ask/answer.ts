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

function askProvider(llm: LlmProviderConfig) {
  return createOpenAI({ apiKey: llm.apiKey, baseURL: llm.baseUrl })
}

function chatModel(llm: LlmProviderConfig) {
  return askProvider(llm).chat(llm.model)
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

      // With web search off, an empty corpus result is a dead end. With it on,
      // the model can still answer from the web, so the generation proceeds.
      if (retrieval.sources.length === 0 && !request.webSearch) {
        writeAssistantText(writer, crypto.randomUUID(), noSourcesMessage(request))
        return
      }

      writer.write({ type: 'data-ask-status', data: { phase: 'generating' }, transient: true })

      const provider = askProvider(llm)
      const answer = streamText({
        model: request.webSearch ? provider.responses(llm.model) : provider.chat(llm.model),
        tools: request.webSearch ? { web_search: provider.tools.webSearch({}) } : undefined,
        instructions: answerInstructions(request.indexName, retrieval.sources, request.webSearch),
        messages: await convertToModelMessages(boundHistory(request.messages)),
        maxOutputTokens: ANSWER_MAX_OUTPUT_TOKENS,
        abortSignal: signal,
      })

      writer.merge(toUIMessageStream({ stream: answer.stream, sendSources: true }))
    },
  })

  return createUIMessageStreamResponse({ stream, consumeSseStream: consumeStream })
}
