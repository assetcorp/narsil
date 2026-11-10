import type { DurableDirectory } from './durable-filesystem'
import type { IndexState, PartitionState } from './manager-state'
import { createSeqOwner, SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type { PartitionLogPosition } from './types'
import { createWalWriter } from './wal-writer'

export interface PartitionRegistry {
  readonly directory: DurableDirectory
  readonly indexes: Map<string, IndexState>
  indexState(indexName: string): IndexState
  partition(indexName: string, partitionId: number, startSeqNo: number, primaryTerm?: number): PartitionState
  freshPartition(indexName: string, partitionId: number, position: PartitionLogPosition): PartitionState
}

export function createPartitionRegistry(directory: DurableDirectory, segmentMaxBytes: number): PartitionRegistry {
  const indexes = new Map<string, IndexState>()

  function indexState(indexName: string): IndexState {
    let state = indexes.get(indexName)
    if (state === undefined) {
      state = {
        partitions: new Map(),
        mutationsSinceCheckpoint: 0,
        documentBytesSinceCheckpoint: 0,
        checkpointInFlight: null,
        unloading: false,
        stalledWrites: [],
      }
      indexes.set(indexName, state)
    }
    return state
  }

  function freshPartition(indexName: string, partitionId: number, position: PartitionLogPosition): PartitionState {
    return {
      walWriter: createWalWriter(directory, { indexName, partitionId, segmentMaxBytes }),
      seqOwner: createSeqOwner(position.seqNo, position.primaryTerm),
      appendChain: Promise.resolve(),
      appliedSeqNo: position.seqNo,
      failed: null,
    }
  }

  return {
    directory,
    indexes,
    indexState,
    freshPartition,

    partition(indexName, partitionId, startSeqNo, primaryTerm = SINGLE_NODE_PRIMARY_TERM) {
      const state = indexState(indexName)
      let partition = state.partitions.get(partitionId)
      if (partition === undefined) {
        partition = freshPartition(indexName, partitionId, { seqNo: startSeqNo, primaryTerm })
        state.partitions.set(partitionId, partition)
      }
      return partition
    },
  }
}
