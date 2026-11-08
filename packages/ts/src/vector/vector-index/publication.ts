import { holdAdmission } from '../admission'
import type { SharedVectorFieldHandles } from '../shared-field/types'
import { untilColdLoaded } from './cold'
import { fieldHandlesOf, type VectorIndexState } from './shared'

export interface VectorPublication {
  handle: string
  sequence: number
  handles: SharedVectorFieldHandles
}

export interface HeldVectorPublication {
  field: VectorPublication
  release(): void
}

export interface VectorPublicationSource {
  prepareCopyPublication(): Promise<void>
  holdCopyPublication(): HeldVectorPublication
}

let nextStore = 0

export function vectorPublicationSource(state: VectorIndexState): VectorPublicationSource {
  const handle = `publication-${++nextStore}`
  return {
    prepareCopyPublication: () => untilColdLoaded(state),
    holdCopyPublication() {
      const pin = holdAdmission(state.store.view)
      try {
        const handles = fieldHandlesOf(state, state.hnsw, true)
        return {
          field: { handle, sequence: pin.admission.pin, handles },
          release: pin.release,
        }
      } catch (error) {
        pin.release()
        throw error
      }
    },
  }
}
