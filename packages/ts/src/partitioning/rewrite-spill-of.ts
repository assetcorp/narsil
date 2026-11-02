import type { RewriteSpill, RewriteStorage, RewriteTarget } from '../persistence/paged/rewrite-spill'
import type { PartitionManager } from './manager'

export async function rewriteSpillOf(
  storage: RewriteStorage | undefined,
  manager: PartitionManager,
  target?: RewriteTarget,
): Promise<RewriteSpill | null> {
  if (storage === undefined || (target?.config ?? manager.config).textStorage !== 'disk') return null
  const { openRewriteSpill } = await import('../persistence/paged/module')
  return openRewriteSpill(storage, manager, target)
}
