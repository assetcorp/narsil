import { nodeHttpUrlOf, nodeSpecOf } from '../topology'

const REQUEST_TIMEOUT_MS = 15_000

export interface NodeFailure {
  status: number
  code: string
  message: string
}

export interface NodeOutcome<T> {
  ok: boolean
  value: T | null
  failure: NodeFailure | null
}

interface ErrorEnvelope {
  error?: {
    code?: unknown
    message?: unknown
  }
}

function failureFrom(status: number, body: unknown): NodeFailure {
  const envelope = body as ErrorEnvelope | null
  const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'HTTP_ERROR'
  const message = typeof envelope?.error?.message === 'string' ? envelope.error.message : `HTTP ${status}`
  return { status, code, message }
}

export async function callNode<T>(
  nodeId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<NodeOutcome<T>> {
  const url = `${nodeHttpUrlOf(nodeSpecOf(nodeId))}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null
    if (!response.ok) {
      return { ok: false, value: null, failure: failureFrom(response.status, parsed) }
    }
    return { ok: true, value: parsed as T, failure: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      value: null,
      failure: { status: 0, code: 'NODE_UNREACHABLE', message },
    }
  } finally {
    clearTimeout(timer)
  }
}
