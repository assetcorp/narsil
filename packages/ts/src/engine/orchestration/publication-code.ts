import type { WorkerAction } from '../../workers/protocol'
import type * as PublicationCode from './publication'
import type { OrchestratorState } from './types'

let publicationCode: typeof PublicationCode | null = null

export async function loadPublicationCode(): Promise<typeof PublicationCode> {
  publicationCode ??= await import('../worker-copies')
  return publicationCode
}

export function publishToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> | undefined {
  return publicationCode?.publishToWorkers(state, action)
}

export function releasePublicationOf(action: WorkerAction): void {
  publicationCode?.releasePublicationOf(action)
}

export function retainPublicationOf(action: WorkerAction): (() => void) | undefined {
  return publicationCode?.retainPublicationOf(action)
}
