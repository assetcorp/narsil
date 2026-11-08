import { codeLoader } from '../../workers/code-loader'
import type { WorkerAction } from '../../workers/protocol'
import type * as PublicationCode from './publication'
import type { OrchestratorState } from './types'

const publicationCode = codeLoader<typeof PublicationCode>(() => import('./publication'), 'worker publication')

export const loadPublicationCode = publicationCode.load

export function publishToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> | undefined {
  return publicationCode.loaded()?.publishToWorkers(state, action)
}

export function releasePublicationOf(action: WorkerAction): void {
  publicationCode.loaded()?.releasePublicationOf(action)
}

export function retainPublicationOf(action: WorkerAction): (() => void) | undefined {
  return publicationCode.loaded()?.retainPublicationOf(action)
}
