import type { ClusterNodeInfo, NodeReadiness } from '../../distribution/cluster-node/types'
import type { NodeRole } from '../../distribution/coordinator/types'
import type { NodeMemoryReport } from '../../distribution/coordinator/types/node'
import type { IndexInfo, PartitionStatsResult, VectorMaintenanceResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { SynonymRule } from '../../types/synonyms'

/**
 * The body of `POST /indexes`, which the server sends once the index exists.
 *
 * @public
 */
export interface IndexCreatedResponse {
  /** The server created the index under this name. */
  name: string
}

/**
 * The body of `GET /indexes`.
 *
 * @public
 */
export interface IndexListResponse {
  /** Each index appears here once, in creation order. */
  indexes: IndexInfo[]
}

/**
 * The body of `DELETE /indexes/{name}`.
 *
 * @public
 */
export interface IndexDroppedResponse {
  /** The server dropped the index with this name. */
  name: string
  /** This is always true. */
  dropped: true
}

/**
 * The body of `GET /indexes/{name}/partitions`.
 *
 * @public
 */
export interface IndexPartitionsResponse {
  /** One entry describes each partition of the index. */
  partitions: PartitionStatsResult[]
}

/**
 * The body of `POST /indexes/{name}/_clear`.
 *
 * @public
 */
export interface IndexClearedResponse {
  /** The server removed every document from the index with this name. */
  name: string
  /** This is always true. */
  cleared: true
}

/**
 * The body of `POST /indexes/{name}/_open` and `POST /indexes/{name}/_close`.
 *
 * @public
 */
export interface IndexStateResponse {
  /** The request changed the index with this name. */
  name: string
  /** The index holds this state now. */
  state: 'open' | 'closed'
}

/**
 * The body of a request that the server finishes with nothing further to report.
 *
 * @public
 */
export interface OkResponse {
  /** This is always true. */
  ok: true
}

/**
 * The body of `POST /indexes/{name}/documents` and of
 * `PATCH /indexes/{name}/documents/{id}`.
 *
 * @public
 */
export interface DocumentIdResponse {
  /** The server wrote the document under this id. */
  id: string
}

/**
 * The body of `PUT /indexes/{name}/documents/{id}`.
 *
 * @public
 */
export interface DocumentPutResponse {
  /** The server wrote the document under this id. */
  id: string
  /** This is true where the id was new, and false where the document replaced an existing one. */
  created: boolean
}

/**
 * The body of `DELETE /indexes/{name}/documents/{id}`.
 *
 * @public
 */
export interface DocumentRemovedResponse {
  /** The server removed the document with this id. */
  id: string
  /** This is always true. */
  removed: true
}

/**
 * The body of `GET /indexes/{name}/documents/{id}`.
 *
 * @public
 */
export interface DocumentResponse {
  /** This is the stored document. */
  document: AnyDocument
}

/**
 * The body of `GET /indexes/{name}/documents/{id}/_exists`.
 *
 * @public
 */
export interface DocumentExistsResponse {
  /** This is true where the index holds a document with the id. */
  exists: boolean
}

/**
 * The body of `GET /indexes/{name}/count`.
 *
 * @public
 */
export interface DocumentCountResponse {
  /** The index holds this many documents. */
  count: number
}

/**
 * The body of `POST /indexes/{name}/documents/_multi-get`.
 *
 * @public
 */
export interface MultiGetResponse {
  /** Each document found appears under its id, and an id with no document has no entry. */
  documents: Record<string, AnyDocument>
}

/**
 * The body of `GET /indexes/{name}/vector-maintenance`.
 *
 * @public
 */
export interface VectorMaintenanceResponse {
  /** One entry describes each vector field of the index. */
  fields: VectorMaintenanceResult[]
}

/**
 * The body of `GET /indexes/{name}/synonyms`, and the body that
 * `POST /indexes/{name}/synonyms` takes.
 *
 * @public
 */
export interface SynonymSetBody {
  /** These rules make up the set, with every word as it was written, and an empty list removes the set. */
  synonyms: SynonymRule[]
}

/**
 * The body that `POST /indexes/{name}/vectors/_compact` and
 * `POST /indexes/{name}/vectors/_optimize` take.
 *
 * @public
 */
export interface VectorFieldBody {
  /** The request covers this vector field, and every vector field of the index where you leave it out. */
  field?: string
}

/**
 * The body of `GET /livez`.
 *
 * @public
 */
export interface LivenessResponse {
  /** This is always `ok`, because the process answered. */
  status: 'ok'
}

/**
 * The cluster node that a server fronts, as `/readyz` and `/cluster` report it.
 *
 * @public
 */
export interface ClusterNodeReport extends ClusterNodeInfo {
  /** This says whether the node can serve requests now. */
  readiness: NodeReadiness
  /** This is true while the node holds the controller lease. */
  isController: boolean
}

/**
 * The body of `GET /readyz` and `GET /health`, which the server sends with
 * status 200 while it is ready and with status 503 while it is not.
 *
 * @public
 */
export interface ReadinessResponse {
  /** This says whether the server can take requests now. */
  status: 'ready' | 'unavailable'
  /** A server that fronts a cluster node describes that node here. */
  cluster?: ClusterNodeReport
}

/**
 * The body of `GET /version`.
 *
 * @public
 */
export interface VersionResponse {
  /** This is always `narsil`. */
  name: 'narsil'
  /** The build came from this package version, or this is null where the build stamped none. */
  version: string | null
  /** The build came from this git commit, or this is null where the build stamped none. */
  gitSha: string | null
  /** This is true when the working tree held uncommitted changes at build time. */
  dirty: boolean
  /** The thread that answered searches vector graphs through the native search core under `native`, and through WebAssembly under `wasm`. */
  vectorSearch: 'native' | 'wasm'
}

/**
 * One member of a cluster, as `GET /cluster` reports it.
 *
 * @public
 */
export interface ClusterMemberReport {
  /** This identifies the node across the cluster. */
  nodeId: string
  /** Peers reach the node at this address. */
  address: string
  /** The node holds these roles in the cluster. */
  roles: NodeRole[]
  /** The node uses this much memory, or null where its runtime cannot measure it. */
  memory: NodeMemoryReport | null
}

/**
 * The body of `GET /cluster`.
 *
 * @public
 */
export interface ClusterTopologyResponse {
  /** This describes the node that answered. */
  node: ClusterNodeReport
  /** This node holds the controller lease, and the value is null while no node holds it. */
  controllerNodeId: string | null
  /** One entry describes each registered node. */
  nodes: ClusterMemberReport[]
}

/**
 * One partition of an index, as `GET /indexes/{name}/cluster` reports it.
 *
 * @public
 */
export interface PartitionAllocationReport {
  /** This identifies the partition within its index. */
  partitionId: number
  /** The partition holds this allocation state. */
  state: string
  /** This node holds the primary copy, and the value is null while no node holds it. */
  primary: string | null
  /** The primary holds this term. */
  primaryTerm: number
  /** The primary has acknowledged writes up to this sequence number. */
  commitPoint: number
  /** These nodes hold replica copies. */
  replicas: string[]
  /** These nodes hold replica copies that are up to date. */
  inSyncSet: string[]
  /** These nodes held a copy before the partition lost its primary. */
  lastHolders: string[]
  /** This says why the partition has no node, and the value is null while it has one. */
  unassignedReason: string | null
}

/**
 * The body of `GET /indexes/{name}/cluster`.
 *
 * @public
 */
export interface ClusterAllocationResponse {
  /** The report covers the index with this name. */
  indexName: string
  /** This is true where the cluster has placed at least one partition of the index. */
  allocated: boolean
  /** The allocation table holds this version, and the value is null where the index has no table. */
  version: number | null
  /** One entry describes each partition, in partition order. */
  partitions: PartitionAllocationReport[]
}

/**
 * The body that `PUT /indexes/{name}/replication-factor` takes.
 *
 * @public
 */
export interface ReplicationFactorBody {
  /** Each partition keeps this many replicas besides its primary. */
  replicationFactor: number
}

/**
 * The body of `PUT /indexes/{name}/replication-factor`.
 *
 * @public
 */
export interface ReplicationFactorResponse {
  /** The request changed the index with this name. */
  indexName: string
  /** Each partition now keeps this many replicas besides its primary. */
  replicationFactor: number
}

/**
 * The code, the message, and the details of one failure, as the server writes it to JSON.
 *
 * @public
 */
export interface ErrorDetail {
  /** This code comes from either {@link ServerErrorCodes} or {@link ErrorCodes}. */
  code: string
  /** This describes the failure, for a log or a person. */
  message: string
  /** These values are behind the failure, such as the field or limit involved. */
  details?: Record<string, unknown>
}

/**
 * One document that a batch refused.
 *
 * @public
 */
export interface BatchFailure {
  /** The batch refused the document with this id. */
  docId: string
  /** This says why the batch refused the document. */
  error: ErrorDetail
}

/**
 * The body of `POST /indexes/{name}/documents/_batch`. One bad document never
 * abandons the rest, so read both lists.
 *
 * @public
 */
export interface BatchResponse {
  /** The server wrote the documents under these ids. */
  succeeded: string[]
  /** The server refused each of these documents. */
  failed: BatchFailure[]
}
