import process from 'node:process'

export interface LlmProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
  titleModel: string
}

export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_LLM_MODEL = 'gpt-5-mini'
export const DEFAULT_TITLE_MODEL = 'gpt-5-mini'

function validatedBaseUrl(raw: string, envName: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${envName} is not a valid URL: "${raw}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http or https, got "${parsed.protocol}"`)
  }
  return raw.trim().replace(/\/+$/, '')
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Resolves the answer-generation model from the environment. Returns null when
 * no API key is configured; the Ask view then explains what to set instead of
 * calling any provider. Read per request and only in server-side code so the
 * key never reaches the client bundle.
 */
export function readLlmConfig(): LlmProviderConfig | null {
  const apiKey = firstNonEmpty(process.env.ASK_LLM_API_KEY, process.env.OPENAI_API_KEY)
  if (apiKey === undefined) return null

  const rawBaseUrl = firstNonEmpty(process.env.ASK_LLM_BASE_URL, process.env.OPENAI_BASE_URL, DEFAULT_LLM_BASE_URL)
  const baseUrl = validatedBaseUrl(rawBaseUrl as string, 'ASK_LLM_BASE_URL')

  const model = firstNonEmpty(process.env.ASK_LLM_MODEL, DEFAULT_LLM_MODEL) as string
  const titleModel = firstNonEmpty(process.env.ASK_TITLE_MODEL, DEFAULT_TITLE_MODEL) as string

  return { apiKey, baseUrl, model, titleModel }
}
