import type { AnyDocument } from '../../types/schema'
import type { MutationContext } from './context'

export interface ChunkFailure {
  error: unknown
}

export interface RecordedMutation {
  docId: string
  document: AnyDocument | null
}

export async function recordChunk(
  ctx: MutationContext,
  indexName: string,
  mutations: readonly RecordedMutation[],
  applies: readonly (() => Promise<void>)[],
): Promise<(ChunkFailure | null)[]> {
  if (mutations.length === 0) return []
  if (ctx.durability) {
    const outcomes = await ctx.durability.recordMutationBatch(
      indexName,
      mutations.map((mutation, i) => ({ docId: mutation.docId, document: mutation.document, apply: applies[i] })),
    )
    return outcomes.map(outcome => (outcome.ok ? null : { error: outcome.error }))
  }
  const failures: (ChunkFailure | null)[] = []
  for (const apply of applies) {
    try {
      await apply()
      failures.push(null)
    } catch (error) {
      failures.push({ error })
    }
  }
  return failures
}
