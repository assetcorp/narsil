import type { AnyDocument } from '../../types/schema'
import type { MutationContext } from './context'

export interface ChunkFailure {
  error: unknown
  refused?: true
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
  if (!ctx.admitsWrites) return recordEvery(ctx, indexName, mutations, applies)
  const failures: (ChunkFailure | null)[] = new Array(mutations.length).fill(null)
  const admitted: number[] = []
  for (let i = 0; i < mutations.length; i++) {
    try {
      ctx.admitWrite(indexName, mutations[i].docId, mutations[i].document)
      admitted.push(i)
    } catch (error) {
      failures[i] = { error, refused: true }
    }
  }
  if (admitted.length === 0) return failures

  const outcomes = await recordEvery(
    ctx,
    indexName,
    admitted.map(i => mutations[i]),
    admitted.map(i => applies[i]),
  )
  for (let k = 0; k < outcomes.length; k++) failures[admitted[k]] = outcomes[k]
  return failures
}

async function recordEvery(
  ctx: MutationContext,
  indexName: string,
  mutations: readonly RecordedMutation[],
  applies: readonly (() => Promise<void>)[],
): Promise<(ChunkFailure | null)[]> {
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
