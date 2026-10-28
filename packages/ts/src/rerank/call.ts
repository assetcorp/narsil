import { ErrorCodes, NarsilError } from '../errors'
import type { RerankAdapter } from '../types/adapters'

function unregistered(adapters: ReadonlyMap<string, RerankAdapter>, name: string): NarsilError {
  const registered = [...adapters.keys()].sort()
  return new NarsilError(
    ErrorCodes.RERANK_CONFIG_INVALID,
    `The query gives rerank adapter "${name}", which this engine has not registered. Register it with registerRerankAdapter or the rerankAdapters setting`,
    { adapter: name, registered },
  )
}

function scoresOf(raw: unknown, expected: number, name: string): number[] {
  const list = Array.isArray(raw)
    ? raw
    : ArrayBuffer.isView(raw) && !(raw instanceof DataView)
      ? Array.from(raw as Float64Array)
      : null
  if (list === null) {
    throw new NarsilError(
      ErrorCodes.RERANK_FAILED,
      `Rerank adapter "${name}" returned ${typeof raw}, expected a list of scores`,
      {
        adapter: name,
      },
    )
  }
  if (list.length !== expected) {
    throw new NarsilError(
      ErrorCodes.RERANK_FAILED,
      `Rerank adapter "${name}" returned ${list.length} scores for ${expected} documents`,
      { adapter: name, expected, actual: list.length },
    )
  }
  const scores = new Array<number>(expected)
  for (let i = 0; i < expected; i++) {
    const score: unknown = list[i]
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new NarsilError(
        ErrorCodes.RERANK_FAILED,
        `Rerank adapter "${name}" returned a score that is not a finite number at position ${i}`,
        { adapter: name, position: i },
      )
    }
    scores[i] = score
  }
  return scores
}

export function requireRerankAdapter(adapters: ReadonlyMap<string, RerankAdapter>, name: string): RerankAdapter {
  const adapter = adapters.get(name)
  if (adapter === undefined) throw unregistered(adapters, name)
  return adapter
}

export interface RerankCallOptions {
  timeoutMs: number
  signal?: AbortSignal
}

function timedOut(name: string, timeoutMs: number): NarsilError {
  return new NarsilError(
    ErrorCodes.RERANK_FAILED,
    `Rerank adapter "${name}" did not answer within ${timeoutMs} ms, so the engine cancelled the call`,
    { adapter: name, timeoutMs },
  )
}

function cancelled(name: string): NarsilError {
  return new NarsilError(ErrorCodes.RERANK_FAILED, `The engine cancelled the call to rerank adapter "${name}"`, {
    adapter: name,
  })
}

function wrapped(err: unknown, name: string): NarsilError {
  if (err instanceof NarsilError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new NarsilError(ErrorCodes.RERANK_FAILED, `Rerank adapter "${name}" failed: ${message}`, {
    adapter: name,
    cause: message,
  })
}

export async function callRerankAdapter(
  adapters: ReadonlyMap<string, RerankAdapter>,
  name: string,
  query: string,
  documents: string[],
  options: RerankCallOptions,
): Promise<number[]> {
  const adapter = requireRerankAdapter(adapters, name)
  if (documents.length === 0) return []
  const outer = options.signal
  if (outer?.aborted) throw cancelled(name)

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let detach: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(timedOut(name, options.timeoutMs))
    }, options.timeoutMs)
    if (outer !== undefined) {
      const onAbort = (): void => {
        controller.abort()
        reject(cancelled(name))
      }
      outer.addEventListener('abort', onAbort, { once: true })
      detach = () => outer.removeEventListener('abort', onAbort)
    }
  })

  let raw: unknown
  try {
    raw = await Promise.race([
      Promise.resolve().then(() => adapter.rerank(query, documents, controller.signal)),
      stopped,
    ])
  } catch (err) {
    throw wrapped(err, name)
  } finally {
    clearTimeout(timer)
    detach?.()
  }
  return scoresOf(raw, documents.length, name)
}
