import type { ClusterNamespace } from '../distribution/cluster-node/types'
import type { Narsil } from '../narsil'
import type { TaskRegistry } from './tasks'

export interface ResolvedLimits {
  maxBodyBytes: number
  maxImportBytes: number
  maxRestoreBytes: number
  maxLineBytes: number
  importBatchSize: number
  maxConcurrentRequests: number
  maxBodyBytesInFlight: number
  maxResultWindow: number
  maxRerankWindow: number
  maxFetchDocuments: number
  maxImportErrors: number
  maxTaskPageSize: number
  maxConcurrentTasks: number
}

/** Build identity the server reports at `/version`, resolved from the optional
 * {@link ServerOptions.build} with nulls where the build stamped nothing. */
export interface ResolvedBuild {
  version: string | null
  gitSha: string | null
  dirty: boolean
}

export interface HandlerDeps {
  engine: Narsil
  tasks: TaskRegistry
  limits: ResolvedLimits
  allowRegex: boolean
  isReady: () => boolean
  build: ResolvedBuild
  cluster: ClusterNamespace | undefined
  requestThreadCount: () => number
}
