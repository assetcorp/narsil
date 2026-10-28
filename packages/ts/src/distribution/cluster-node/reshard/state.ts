export interface ReshardBlock {
  jobId: string
  partitionId: number
  marker: number
}

export interface ReshardCopyJob {
  jobId: string
  indexName: string
  sourceGeneration: string
  targetGeneration: string
  partitionId: number
  sourcePartitionCount: number
  targetPartitionCount: number
  primaryTerm: number
  stopped: boolean
  snapshotSeqNo: Promise<number>
}

export interface ReshardState {
  blocks: Map<string, ReshardBlock>
  checkedTerms: Map<string, number>
  publicNames: Map<string, string>
  jobs: Map<string, ReshardCopyJob>
  acceptedTerms: Map<string, number>
  nextMarker: number
}

export function createReshardState(): ReshardState {
  return {
    blocks: new Map(),
    checkedTerms: new Map(),
    publicNames: new Map(),
    jobs: new Map(),
    acceptedTerms: new Map(),
    nextMarker: 0,
  }
}

export function partitionKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

export function jobKey(jobId: string, partitionId: number): string {
  return `${jobId}:${partitionId}`
}

export function setReshardBlock(state: ReshardState, indexName: string, jobId: string, partitionId: number): void {
  state.nextMarker += 1
  state.blocks.set(partitionKey(indexName, partitionId), { jobId, partitionId, marker: state.nextMarker })
}

export function forgetReshardIndex(state: ReshardState, indexName: string): void {
  const prefix = `${indexName}:`
  for (const key of [...state.blocks.keys()]) if (key.startsWith(prefix)) state.blocks.delete(key)
  for (const key of [...state.checkedTerms.keys()]) if (key.startsWith(prefix)) state.checkedTerms.delete(key)
}

export function forgetReshardPartition(state: ReshardState, indexName: string, partitionId: number): void {
  const key = partitionKey(indexName, partitionId)
  state.blocks.delete(key)
  state.checkedTerms.delete(key)
}

export function stopEveryReshardJob(state: ReshardState): void {
  for (const job of state.jobs.values()) job.stopped = true
  state.jobs.clear()
}
