import type { VectorIndex, VectorIndexPartsPlan } from '../../vector/vector-index'
import type { DurableDirectory } from './durable-filesystem'
import type { IndexState, PartitionState } from './manager-state'
import { snapshotCheckpointFor } from './recovery'
import {
  readSegmentManifest,
  type VectorCheckpointLayout,
  type VectorsWrittenFromMemory,
  writeLiveVectors,
} from './segment'
import { SINGLE_NODE_PRIMARY_TERM } from './seq-owner'
import type { PartitionCheckpoint } from './snapshot-bundle'

const ONLY_PARTITION = 0

export interface CheckpointedPartitions {
  readonly partitionCount: number
  countDocuments(): number
}

export interface CheckpointCapture {
  targets: PartitionCheckpoint[]
  documentCount: number
  vectorPlans: Map<string, VectorIndexPartsPlan> | null
}

export interface LiveVectorsWritten {
  vectorsAlreadyWritten: VectorsWrittenFromMemory
  layouts: VectorCheckpointLayout[]
}

function whileNoMutationApplies<T>(partitions: readonly PartitionState[], capture: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let release: () => void = () => undefined
    const released = new Promise<void>(settle => {
      release = settle
    })
    function captureNow(): void {
      try {
        resolve(capture())
      } catch (error) {
        reject(error)
      } finally {
        release()
      }
    }
    let waiting = partitions.length
    if (waiting === 0) {
      captureNow()
      return
    }
    for (const partition of partitions) {
      partition.appendChain = partition.appendChain.then(() => {
        waiting -= 1
        if (waiting === 0) captureNow()
        return released
      })
    }
  })
}

function savesTheLiveVectorIndexes(partitionCount: number, vectorIndexes: Map<string, VectorIndex>): boolean {
  return partitionCount === 1 && vectorIndexes.size > 0
}

export async function makeEveryAppliedMutationDurable(
  indexState: IndexState,
  markFatal: (error: Error) => void,
): Promise<void> {
  for (const partition of [...indexState.partitions.values()]) {
    await partition.appendChain
    if (partition.failed !== null) throw partition.failed
    try {
      await partition.walWriter.commit()
    } catch (error) {
      partition.failed = error instanceof Error ? error : new Error(String(error))
      markFatal(partition.failed)
      throw partition.failed
    }
  }
}

export async function captureCheckpoint(
  indexState: IndexState,
  manager: CheckpointedPartitions,
  vectorIndexes: Map<string, VectorIndex>,
): Promise<CheckpointCapture> {
  const live = savesTheLiveVectorIndexes(manager.partitionCount, vectorIndexes)
  if (live) {
    for (const vectorIndex of vectorIndexes.values()) await vectorIndex.completeGraph()
  }
  return whileNoMutationApplies([...indexState.partitions.values()], () => {
    const partitionCount = manager.partitionCount
    const documentCount = manager.countDocuments()
    const targets: PartitionCheckpoint[] = []
    for (let partitionId = 0; partitionId < partitionCount; partitionId += 1) {
      const partition = indexState.partitions.get(partitionId)
      targets.push({
        partitionId,
        lastSeqNo: partition?.appliedSeqNo ?? 0,
        primaryTerm: partition?.seqOwner.primaryTerm ?? SINGLE_NODE_PRIMARY_TERM,
      })
    }
    if (!live || partitionCount !== 1) return { targets, documentCount, vectorPlans: null }
    const vectorPlans = new Map<string, VectorIndexPartsPlan>()
    for (const [fieldPath, vectorIndex] of vectorIndexes) vectorPlans.set(fieldPath, vectorIndex.planParts())
    return { targets, documentCount, vectorPlans }
  })
}

export async function writeCapturedVectors(
  directory: DurableDirectory,
  indexName: string,
  capture: CheckpointCapture,
  rewriteUnchanged: boolean,
): Promise<LiveVectorsWritten> {
  if (capture.vectorPlans === null) return { vectorsAlreadyWritten: {}, layouts: [] }
  const priorManifest = await readSegmentManifest(directory, indexName)
  const priorVectors = priorManifest?.partitions.find(entry => entry.partitionId === ONLY_PARTITION)?.vectors ?? []
  const priorSeqNo = snapshotCheckpointFor(priorManifest?.checkpoint ?? [], ONLY_PARTITION)
  const lastSeqNo = capture.targets[ONLY_PARTITION]?.lastSeqNo ?? 0
  const everyFieldWritten = [...capture.vectorPlans.keys()].every(fieldPath =>
    priorVectors.some(ref => ref.fieldPath === fieldPath),
  )
  if (!rewriteUnchanged && everyFieldWritten && lastSeqNo === priorSeqNo) {
    return { vectorsAlreadyWritten: { [ONLY_PARTITION]: priorVectors }, layouts: [] }
  }
  const written = await writeLiveVectors({
    directory,
    indexName,
    partitionId: ONLY_PARTITION,
    plans: capture.vectorPlans,
    priorVectors,
  })
  return { vectorsAlreadyWritten: { [ONLY_PARTITION]: written.refs }, layouts: written.layouts }
}
