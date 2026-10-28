import { fnv1a } from '../../core/hash'
import type { EngineCore } from '../../engine/core'
import type { ChunkFailure, EngineWriteAdmission, WriteAdmission } from '../../engine/mutations'
import type { AnyDocument } from '../../types/schema'

export function createEngineWriteAdmission(core: EngineCore, admission: WriteAdmission): EngineWriteAdmission {
  function admit(indexName: string, docId: string, document: AnyDocument | null): void {
    const partitionCount = Math.max(1, core.requireManager(indexName).partitionCount)
    admission(indexName, fnv1a(docId) % partitionCount, docId, document)
  }

  return {
    admit,
    async recordChunk(ctx, indexName, mutations, applies, recordAdmitted) {
      const failures = new Array<ChunkFailure | null>(mutations.length).fill(null)
      const admitted: number[] = []
      for (let i = 0; i < mutations.length; i++) {
        try {
          admit(indexName, mutations[i].docId, mutations[i].document)
          admitted.push(i)
        } catch (error) {
          failures[i] = { error, refused: true }
        }
      }
      if (admitted.length === 0) return failures

      const outcomes = await recordAdmitted(
        { ...ctx, writeAdmission: null },
        indexName,
        admitted.map(i => mutations[i]),
        admitted.map(i => applies[i]),
      )
      for (let k = 0; k < outcomes.length; k++) failures[admitted[k]] = outcomes[k]
      return failures
    },
  }
}
