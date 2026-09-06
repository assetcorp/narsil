import type { MutationContext } from './context'

export async function awaitWriteVisibility(ctx: MutationContext, indexName: string): Promise<void> {
  await ctx.awaitRebalanceReplay(indexName)
  await ctx.orchestrator.awaitWrites(indexName)
}
