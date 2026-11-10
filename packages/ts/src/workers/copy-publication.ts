import type { PartitionManager } from '../partitioning/manager'
import type { HeldVectorPublication, VectorPublication } from '../vector/vector-index/publication'
import { advanceCopyGeneration, copyGenerationOf } from './copy-generation'

export interface CopyPublication {
  generation: number
  fields: Array<{ fieldName: string; vector: VectorPublication }>
}

export interface HeldCopyPublication {
  publication: CopyPublication
  release(): void
  retain(): () => void
}

export function holdCopyPublication(manager: PartitionManager, advances: boolean): HeldCopyPublication {
  const held: HeldVectorPublication[] = []
  try {
    const fields: CopyPublication['fields'] = []
    for (const [fieldName, vector] of manager.getVectorIndexes()) {
      const pin = vector.holdCopyPublication()
      held.push(pin)
      fields.push({ fieldName, vector: pin.field })
    }
    const generation = advances ? advanceCopyGeneration(manager) : copyGenerationOf(manager)
    let references = 0
    const retain = (): (() => void) => {
      references++
      let released = false
      return () => {
        if (released) return
        released = true
        if (--references === 0) for (const pin of held.splice(0)) pin.release()
      }
    }
    return {
      publication: { generation, fields },
      release: retain(),
      retain,
    }
  } catch (error) {
    for (const pin of held) pin.release()
    throw error
  }
}
