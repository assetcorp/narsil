import type { WorkerAction } from '../../workers/protocol'
import {
  publishToWorkers as publishLoadedCopies,
  releasePublicationOf as releaseLoadedPublication,
  retainPublicationOf as retainLoadedPublication,
} from './publication'
import type { OrchestratorState } from './types'

let publicationLoaded = false

export async function loadPublicationCode(): Promise<void> {
  publicationLoaded = true
}

export function publishToWorkers(state: OrchestratorState, action: WorkerAction): Promise<void> | undefined {
  return publicationLoaded ? publishLoadedCopies(state, action) : undefined
}

export function releasePublicationOf(action: WorkerAction): void {
  if (publicationLoaded) releaseLoadedPublication(action)
}

export function retainPublicationOf(action: WorkerAction): (() => void) | undefined {
  return publicationLoaded ? retainLoadedPublication(action) : undefined
}
