import type { ChunkFailure, MutationContext, RecordedMutation } from './context'

export type { ChunkFailure, RecordedMutation } from './context'

export async function recordChunk(
  ctx: MutationContext,
  indexName: string,
  mutations: readonly RecordedMutation[],
  applies: readonly (() => Promise<void>)[],
): Promise<(ChunkFailure | null)[]> {
  if (mutations.length === 0) return []
  const admission = ctx.writeAdmission
  if (admission !== null) return admission.recordChunk(ctx, indexName, mutations, applies, recordEvery)
  return recordEvery(ctx, indexName, mutations, applies)
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
