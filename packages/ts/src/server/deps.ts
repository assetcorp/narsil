import type { Narsil } from '../narsil'
import type { TaskRegistry } from './tasks'

export interface ResolvedLimits {
  maxBodyBytes: number
  maxImportBytes: number
  maxLineBytes: number
  importBatchSize: number
  maxConcurrentRequests: number
  maxResultWindow: number
  maxFetchDocuments: number
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
  isReady: () => boolean
  build: ResolvedBuild
}
