import { describe, expect, it } from 'vitest'
import { captureCheckpoint, makeEveryAppliedMutationDurable } from '../../../persistence/durability/checkpoint-capture'
import type { IndexState, PartitionState } from '../../../persistence/durability/manager-state'
import type { VectorIndex } from '../../../vector/vector-index'

interface Gate {
  opened: Promise<void>
  open(): void
}

function gate(): Gate {
  let open: () => void = () => undefined
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

function partitionState(commit: () => Promise<void> = async () => undefined): PartitionState {
  return {
    walWriter: { commit } as PartitionState['walWriter'],
    seqOwner: { primaryTerm: 1 } as PartitionState['seqOwner'],
    appendChain: Promise.resolve(),
    appliedSeqNo: 0,
    failed: null,
  }
}

function indexStateOf(partition: PartitionState): IndexState {
  return {
    partitions: new Map([[0, partition]]),
    mutationsSinceCheckpoint: 0,
    checkpointInFlight: null,
    unloading: false,
    documentBytesSinceCheckpoint: 0,
    stalledWrites: [],
  }
}

const NO_VECTOR_FIELDS = new Map<string, VectorIndex>()

describe('capturing a checkpoint', () => {
  it('waits for the mutation that is being applied and holds the next one back until it has captured', async () => {
    const partition = partitionState()
    const applying = gate()
    const events: string[] = []
    partition.appendChain = partition.appendChain.then(async () => {
      await applying.opened
      partition.appliedSeqNo = 7
      events.push('first mutation applied')
    })
    const documents = {
      partitionCount: 1,
      countDocuments(): number {
        events.push('captured')
        return partition.appliedSeqNo
      },
    }

    const capturing = captureCheckpoint(indexStateOf(partition), documents, NO_VECTOR_FIELDS)
    partition.appendChain = partition.appendChain.then(() => {
      partition.appliedSeqNo = 8
      events.push('second mutation applied')
    })
    applying.open()
    const capture = await capturing
    await partition.appendChain

    expect(capture.targets).toEqual([{ partitionId: 0, lastSeqNo: 7, primaryTerm: 1 }])
    expect(capture.documentCount).toBe(7)
    expect(events).toEqual(['first mutation applied', 'captured', 'second mutation applied'])
  })

  it('lets mutations continue after a capture that throws', async () => {
    const partition = partitionState()
    const documents = {
      partitionCount: 1,
      countDocuments(): number {
        throw new Error('the count failed')
      },
    }

    await expect(captureCheckpoint(indexStateOf(partition), documents, NO_VECTOR_FIELDS)).rejects.toThrow(
      'the count failed',
    )
    let applied = false
    await partition.appendChain.then(() => {
      applied = true
    })
    expect(applied).toBe(true)
  })
})

describe('making every applied mutation durable before the manifest is written', () => {
  it('stops the checkpoint where a partition failed to append a mutation', async () => {
    const partition = partitionState()
    partition.failed = new Error('the append failed')

    await expect(makeEveryAppliedMutationDurable(indexStateOf(partition), () => undefined)).rejects.toThrow(
      'the append failed',
    )
  })

  it('marks the log fatal where the sync fails', async () => {
    const partition = partitionState(async () => {
      throw new Error('the sync failed')
    })
    const fatal: Error[] = []

    await expect(makeEveryAppliedMutationDurable(indexStateOf(partition), error => fatal.push(error))).rejects.toThrow(
      'the sync failed',
    )
    expect(fatal.map(error => error.message)).toEqual(['the sync failed'])
    expect(partition.failed?.message).toBe('the sync failed')
  })
})
