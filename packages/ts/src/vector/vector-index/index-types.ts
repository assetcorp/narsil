import type { VectorQuantizationMode, VectorStorageMode } from '../../types/schema'
import type { VectorMetric } from '../brute-force'
import type { VectorCheckpointPlan, WrittenVectorFile } from './checkpoint-plan'
import type { CheckpointRestoreShape, VectorCheckpointRestore } from './checkpoint-restore'
import type { ColdFieldLoad } from './cold'
import type { VectorFileLayout } from './disk'
import type { VectorIndexPayload } from './payload'
import type { VectorPublicationSource } from './publication'
import type { ColdVectorField, MaintenanceStatus, VectorSearchOptions, VectorSearchOutcome } from './shared'

export interface VectorIndex extends VectorPublicationSource {
  insert(docId: string, vector: Float32Array, partitionId?: number): void
  remove(docId: string): void
  /** Reports whether every stored vector names the partition it belongs to. */
  partitionsKnown(): boolean
  assignPartitions(resolve: (docId: string) => number | undefined): void
  scheduleBuild(): void
  awaitPendingBuild(): Promise<void>
  /** Places every live vector in the graph, building one where the field holds none and enough vectors for one, and resolves once every vector is in. A checkpoint calls this so that the parts it writes carry the graph. */
  completeGraph(): Promise<void>
  dispose(): Promise<void>
  search(query: Float32Array, k: number, options: VectorSearchOptions): VectorSearchOutcome
  searchParallel(query: Float32Array, k: number, options: VectorSearchOptions): Promise<VectorSearchOutcome>
  /** Calls `listener` with the document ID of every vector write, before the write changes the field, until the returned function runs. */
  watchWrites(listener: (docId: string) => void): () => void
  /** Withdraws the field from the worker threads and sends it again where the policy names a host. */
  refreshWorkerCopies(): void
  getVector(docId: string): Float32Array | null
  has(docId: string): boolean
  compact(): void
  optimize(): Promise<void>
  maintenanceStatus(): MaintenanceStatus
  estimateMemoryBytes(): number
  /** Reports the bytes that storing this many more vectors would add to the field's shared structures. */
  growthBytesFor(vectors: number): number
  /** Reads the field back from the parts of an earlier snapshot, whose parts can place the sequences of several partitions end to end, and keeps every vector in memory. */
  deserialize(parts: VectorIndexPayload[]): void
  /** Fixes what a checkpoint writes for the field now: the vector files that it keeps with their dead vectors, the vectors that go into new files, and the graph with every vector numbered by that file list. The plan reads one new file at a time, so that a checkpoint holds one file in memory while it writes a field of any size. Where `pinsRetiredVectors` is true, every new file holds the vector that each document held when the plan was made, and the field keeps replaced and removed vectors readable until the plan's `release` runs. */
  planCheckpoint(
    listedKeys: readonly string[] | null,
    rewritesGraph?: boolean,
    pinsRetiredVectors?: boolean,
  ): VectorCheckpointPlan
  /** Records the files of a checkpoint whose manifest is durable, so that the next plan writes the vectors that arrive after it and no others. */
  recordCheckpoint(plan: VectorCheckpointPlan, written: readonly WrittenVectorFile[]): void
  /** Empties the field and returns a reader that takes a checkpoint's vector files one at a time, in manifest order, after the graph that `shape` carries. A field kept on disk reads its vectors from the files where the checkpoint holds a graph or enough vectors for one, and a dead vector that the graph holds a node for comes back as a tombstone. */
  restoreCheckpoint(shape: CheckpointRestoreShape): VectorCheckpointRestore
  /** Answers from the field's files by position while `load` restores its codes and graph, and it holds any write until that load ends. */
  openColdField(field: ColdVectorField, load: ColdFieldLoad): void
  startShuffledRebuildWhenDue(): void
  /** Lists the paths of the vector files that the field still reads vectors from. */
  vectorFilesInUse(): string[]
  /** Points the vectors a checkpoint wrote at their places in its file and frees the blocks they emptied, or keeps those places while the field holds no graph. It resolves once every thread holding the field has taken the new layout. */
  adoptDiskLayout(layout: VectorFileLayout): Promise<void>
  /** Withdraws the field from every thread that holds a copy of it and closes every vector file that this thread holds open or maps, so that the caller can delete those files on any platform. It resolves once every thread has closed its copy, and the field opens a file again when a search next reads a vector from it. */
  releaseVectorFiles(): Promise<void>
  relocateVectorFiles(rewrite: (path: string) => string): void
  holdWorkerCopies(): Promise<void>
  resumeWorkerCopies(): void
  readonly size: number
  readonly dimension: number
  readonly fieldName: string
  /** The mode the field codes its vectors in. */
  readonly quantization: VectorQuantizationMode
  /** Where the field keeps its full-precision vectors. */
  readonly storage: VectorStorageMode
  readonly metric: VectorMetric
}
