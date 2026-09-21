import type { ReplicationLogEntry } from '../../distribution/replication/types'
import type { PartitionState } from './manager-state'
import type { MutationOutcome, MutationRecord } from './types'

export interface PartitionBatchDeps {
  syncEachBatch: boolean
  fatalError(): Error | null
  markFatal(error: Error): void
  buildEntry(record: MutationRecord, seqNo: number): ReplicationLogEntry
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function failUnlessAlreadyFailed(outcomes: MutationOutcome[], count: number, error: Error): void {
  for (let i = 0; i < count; i++) {
    const outcome = outcomes[i]
    if (outcome === undefined || outcome.ok) {
      outcomes[i] = { ok: false, error }
    }
  }
}

function failPartition(partition: PartitionState, deps: PartitionBatchDeps, err: unknown): Error {
  const error = toError(err)
  partition.failed = error
  deps.markFatal(error)
  return error
}

export async function recordBatchesByPartition(
  records: readonly MutationRecord[],
  partitionOf: (record: MutationRecord) => PartitionState,
  deps: PartitionBatchDeps,
): Promise<MutationOutcome[]> {
  const positionsByPartition = new Map<PartitionState, number[]>()
  for (let i = 0; i < records.length; i++) {
    const partition = partitionOf(records[i])
    const positions = positionsByPartition.get(partition)
    if (positions === undefined) {
      positionsByPartition.set(partition, [i])
    } else {
      positions.push(i)
    }
  }

  const outcomes: MutationOutcome[] = new Array(records.length)
  await Promise.all(
    [...positionsByPartition].map(async ([partition, positions]) => {
      const partitionOutcomes = await recordPartitionBatch(
        partition,
        positions.map(position => records[position]),
        deps,
      )
      for (let i = 0; i < positions.length; i++) {
        outcomes[positions[i]] = partitionOutcomes[i]
      }
    }),
  )
  return outcomes
}

export async function recordPartitionBatch(
  partition: PartitionState,
  records: readonly MutationRecord[],
  deps: PartitionBatchDeps,
): Promise<MutationOutcome[]> {
  const outcomes: MutationOutcome[] = new Array(records.length)
  let appendedCount = 0

  const appended = partition.appendChain.then(async () => {
    const fatal = deps.fatalError()
    if (fatal !== null) {
      throw fatal
    }
    if (partition.failed !== null) {
      throw partition.failed
    }
    const applied: number[] = []
    for (let i = 0; i < records.length; i++) {
      try {
        await records[i].apply()
        applied.push(i)
      } catch (err) {
        outcomes[i] = { ok: false, error: err }
      }
    }
    if (applied.length === 0) {
      return
    }
    let lastSeqNo = partition.appliedSeqNo
    try {
      const entries: ReplicationLogEntry[] = []
      for (const i of applied) {
        lastSeqNo = partition.seqOwner.next()
        outcomes[i] = { ok: true, seqNo: lastSeqNo }
        entries.push(deps.buildEntry(records[i], lastSeqNo))
      }
      await partition.walWriter.appendAll(entries)
    } catch (err) {
      throw failPartition(partition, deps, err)
    }
    partition.appliedSeqNo = lastSeqNo
    appendedCount = applied.length
  })
  partition.appendChain = appended.catch(() => undefined)

  try {
    await appended
    if (deps.syncEachBatch && appendedCount > 0) {
      try {
        await partition.walWriter.commit()
      } catch (err) {
        throw failPartition(partition, deps, err)
      }
    }
  } catch (err) {
    failUnlessAlreadyFailed(outcomes, records.length, toError(err))
  }
  return outcomes
}
