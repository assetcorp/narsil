import { setTimeout as delay } from 'node:timers/promises'
import { DOWNLOAD_ATTEMPTS, DOWNLOAD_RETRY_DELAY_MS, REQUEST_TIMEOUT_MS } from './constants'

const RETRIABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const REQUEST_HEADERS = { 'User-Agent': 'narsil-conformance-suite' }

class RetriableResponse extends Error {}

async function fetchOnce(url: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (RETRIABLE_STATUSES.has(response.status)) throw new RetriableResponse(`${url} answered ${response.status}`)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${url} declares ${declared} bytes, above the limit of ${maxBytes}`)
  }
  if (response.body === null) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      total += step.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`${url} sent more than the limit of ${maxBytes} bytes`)
      }
      chunks.push(step.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

function isRetriable(error: unknown): boolean {
  if (error instanceof RetriableResponse) return true
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError
}

export async function fetchBytes(url: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(url, maxBytes)
    } catch (error) {
      if (attempt >= DOWNLOAD_ATTEMPTS || !isRetriable(error)) throw error
      await delay(DOWNLOAD_RETRY_DELAY_MS * attempt)
    }
  }
}
