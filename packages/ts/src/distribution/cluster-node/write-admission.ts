import { fnv1a } from '../../core/hash'
import type { EngineCore } from '../../engine/core'
import type {
  ApplyMutation,
  DurabilityRecorder,
  DurableMutation,
  DurableWriteOutcome,
  DurableWriteToken,
} from '../../engine/mutations/context'
import type { AnyDocument } from '../../types/schema'

export type WriteAdmission = (
  indexName: string,
  partitionId: number,
  docId: string,
  document: AnyDocument | null,
) => void

export function createAdmittingRecorder(
  core: EngineCore,
  admission: WriteAdmission,
  durable: DurabilityRecorder | null,
): DurabilityRecorder {
  function admit(indexName: string, docId: string, document: AnyDocument | null): number {
    const partitionId = fnv1a(docId) % Math.max(1, core.requireManager(indexName).partitionCount)
    admission(indexName, partitionId, docId, document)
    return partitionId
  }

  async function applyAdmitted(
    indexName: string,
    partitionId: number,
    apply: ApplyMutation,
  ): Promise<DurableWriteToken> {
    await apply()
    return { indexName, partitionId, seqNo: 0 }
  }

  return {
    async recordInsertOrUpdate(indexName, docId, document, apply) {
      const partitionId = admit(indexName, docId, document)
      if (durable === null) return applyAdmitted(indexName, partitionId, apply)
      return durable.recordInsertOrUpdate(indexName, docId, document, apply)
    },

    async recordRemove(indexName, docId, apply) {
      const partitionId = admit(indexName, docId, null)
      if (durable === null) return applyAdmitted(indexName, partitionId, apply)
      return durable.recordRemove(indexName, docId, apply)
    },

    async recordMutationBatch(indexName, mutations) {
      const outcomes = new Array<DurableWriteOutcome>(mutations.length)
      const admitted: DurableMutation[] = []
      const positions: number[] = []
      const partitionIds: number[] = []
      for (let i = 0; i < mutations.length; i++) {
        try {
          partitionIds.push(admit(indexName, mutations[i].docId, mutations[i].document))
          admitted.push(mutations[i])
          positions.push(i)
        } catch (error) {
          outcomes[i] = { ok: false, error }
        }
      }
      if (admitted.length === 0) return outcomes

      if (durable !== null) {
        const recorded = await durable.recordMutationBatch(indexName, admitted)
        for (let k = 0; k < recorded.length; k++) outcomes[positions[k]] = recorded[k]
        return outcomes
      }
      for (let k = 0; k < admitted.length; k++) {
        try {
          outcomes[positions[k]] = {
            ok: true,
            write: await applyAdmitted(indexName, partitionIds[k], admitted[k].apply),
          }
        } catch (error) {
          outcomes[positions[k]] = { ok: false, error }
        }
      }
      return outcomes
    },
  }
}
