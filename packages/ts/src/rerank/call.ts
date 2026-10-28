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

export async function callRerankAdapter(
  adapters: ReadonlyMap<string, RerankAdapter>,
  name: string,
  query: string,
  documents: string[],
  signal?: AbortSignal,
): Promise<number[]> {
  const adapter = requireRerankAdapter(adapters, name)
  let raw: unknown
  try {
    raw = await adapter.rerank(query, documents, signal)
  } catch (err) {
    if (err instanceof NarsilError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new NarsilError(ErrorCodes.RERANK_FAILED, `Rerank adapter "${name}" failed: ${message}`, {
      adapter: name,
      cause: message,
    })
  }
  return scoresOf(raw, documents.length, name)
}
