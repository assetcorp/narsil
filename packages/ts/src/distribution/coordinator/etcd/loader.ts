import { ErrorCodes, NarsilError } from '../../../errors'

export async function loadEtcd3Module(): Promise<typeof import('etcd3')> {
  try {
    return await import('etcd3')
  } catch (err) {
    throw new NarsilError(
      ErrorCodes.COORDINATOR_DEPENDENCY_MISSING,
      'The `etcd3` package is not installed. Install it with `pnpm add etcd3` (or the npm or yarn equivalent) to use createEtcdCoordinator.',
      { cause: err instanceof Error ? err.message : String(err) },
    )
  }
}
