import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartitionManager } from '../../../partitioning/manager'
import { releaseLayoutCheckpoint } from '../../../partitioning/manager/checkpoint-prefix'
import { switchDurableRouting } from '../../../partitioning/wal-routing'
import { checkpointInTurn } from '../checkpoint-turn'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import type { PartitionRegistry } from '../partition-registry'
import { directoryCheckpointStore } from '../segment/store'
import { SINGLE_NODE_PRIMARY_TERM } from '../seq-owner'
import { writeTransition } from './codec'

export async function transitionWalLayout(
  registry: PartitionRegistry,
  indexName: string,
  manager: PartitionManager,
  replay: () => Promise<void>,
): Promise<void> {
  const state = registry.indexState(indexName)
  await switchDurableRouting(manager, oldPartitionCount =>
    checkpointInTurn(state, {
      joinsInFlight: false,
      mayStart: () => {
        if (state.unloading) {
          throw new NarsilError(
            ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
            'The index is unloading during rebalance',
          )
        }
        return true
      },
      afterSettling: () => undefined,
      perform: async () => {
        await replay()
        const oldHeads: PartitionCheckpoint[] = []
        for (let partitionId = 0; partitionId < oldPartitionCount; partitionId++) {
          const partition = state.partitions.get(partitionId)
          if (partition !== undefined) {
            await partition.appendChain
            if (partition.failed !== null) throw partition.failed
            await partition.walWriter.commit()
          }
          oldHeads.push({
            partitionId,
            lastSeqNo: partition?.appliedSeqNo ?? 0,
            primaryTerm: partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM,
          })
        }
        await writeTransition(directoryCheckpointStore(registry.directory), indexName, {
          version: 1,
          oldPartitionCount,
          newPartitionCount: manager.partitionCount,
          oldHeads,
        })
        releaseLayoutCheckpoint(manager)
      },
    }),
  )
}
