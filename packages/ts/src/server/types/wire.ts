import type { ClusterHealth } from '../../distribution/cluster-node/types/observability'
import type {
  GroupResult,
  IndexStats,
  ListResult,
  PreflightResult,
  QueryResult,
  SuggestResult,
} from '../../types/results'
import type { BM25Params, FieldType, PartitionConfig, SchemaDefinition, VectorIndexConfig } from '../../types/schema'
import type { GroupConfig, ListParams, QueryParams, SuggestParams } from '../../types/search'
import type { ErrorEnvelope } from './options'
import type {
  BatchBody,
  CapabilitiesResponse,
  ChangeAnalysisBody,
  CreateIndexRequest,
  DocumentBody,
  HttpIndexConfig,
  ImportResult,
  InsertBody,
  MemoryStatsResponse,
  MultiGetBody,
  RebalanceBody,
} from './requests'
import type {
  BatchResponse,
  ClusterAllocationResponse,
  ClusterTopologyResponse,
  DocumentCountResponse,
  DocumentExistsResponse,
  DocumentIdResponse,
  DocumentPutResponse,
  DocumentRemovedResponse,
  DocumentResponse,
  IndexClearedResponse,
  IndexCreatedResponse,
  IndexDroppedResponse,
  IndexListResponse,
  IndexPartitionsResponse,
  IndexStateResponse,
  LivenessResponse,
  MultiGetResponse,
  OkResponse,
  ReadinessResponse,
  ReplicationFactorBody,
  ReplicationFactorResponse,
  SynonymSetBody,
  VectorFieldBody,
  VectorMaintenanceResponse,
  VersionResponse,
} from './responses'
import type { TaskListPage, TaskListQuery, TaskRecord } from './tasks'

/**
 * Everything `POST /indexes/{name}/search` accepts, which is {@link QueryParams}
 * with a `group` that holds no reducer, because a function cannot cross JSON.
 *
 * @public
 */
export type HttpQueryParams = Omit<QueryParams, 'group'> & {
  /** These settings collapse the hits into groups by field value. */
  group?: Omit<GroupConfig, 'reduce'>
}

/**
 * One group of hits as the server sends it, which is {@link GroupResult} with
 * no reducer output, because the server refuses a query with a reducer.
 *
 * @public
 */
export type HttpGroupResult = Omit<GroupResult, 'reduced' | 'reducerError'>

/**
 * The body of `POST /indexes/{name}/search`.
 *
 * @public
 */
export type HttpQueryResult = Omit<QueryResult, 'groups'> & {
  /** These groups arrive when the query asked for grouping. */
  groups?: HttpGroupResult[]
}

/**
 * The settings of a new index as `POST /indexes` reads them, which is
 * {@link HttpIndexConfig} with each field type spelled out.
 *
 * @public
 */
export type HttpIndexBody = Omit<HttpIndexConfig, 'schema' | 'partitions' | 'vectorPromotion'> & {
  /** This layout gives each value as either a field type or a nested schema. */
  schema: SchemaDefinition
  /** These settings control how the index splits documents across partitions as it grows. */
  partitions?: PartitionConfig
  /** These settings control when vector fields move to an HNSW graph, and how that graph is built. */
  vectorPromotion?: VectorIndexConfig
}

/**
 * The body of `POST /indexes`, which is {@link CreateIndexRequest} with the
 * settings of {@link HttpIndexBody}.
 *
 * @public
 */
export type HttpCreateIndexBody = Omit<CreateIndexRequest, 'config'> & {
  /** This carries the schema and settings, in the subset JSON can express. */
  config: HttpIndexBody
}

/**
 * The query string of `DELETE /indexes/{name}/documents/{id}`.
 *
 * @public
 */
export interface RemoveDocumentQuery {
  /** Under `true`, the server answers only once every worker copy has applied the removal. */
  wait?: 'true' | 'false'
}

/**
 * The query string of `POST /indexes/{name}/documents/_import`.
 *
 * @public
 */
export interface ImportDocumentsQuery {
  /** Under `true`, the server starts a task and answers 202 with its record. */
  async?: 'true' | 'false'
}

/**
 * Every named type that a route of the HTTP server sends or takes as JSON,
 * under the name that the published OpenAPI file gives its schema.
 *
 * @public
 */
export interface HttpWireTypes {
  /** The body of `POST /indexes/{name}/documents/_batch`, which gives the action to perform. */
  BatchBody: BatchBody
  /** The body of `POST /indexes/{name}/bm25`. */
  BM25Params: BM25Params
  /** The body of `POST /indexes/{name}/_change-analysis`. */
  ChangeAnalysisBody: ChangeAnalysisBody
  /** The body of `POST /indexes`. */
  HttpCreateIndexBody: HttpCreateIndexBody
  /** The body of a request that writes one document with a known id. */
  DocumentBody: DocumentBody
  /** Every value that a field of an index schema accepts. */
  FieldType: FieldType
  /** The query string of `POST /indexes/{name}/documents/_import`. */
  ImportDocumentsQuery: ImportDocumentsQuery
  /** The body of `POST /indexes/{name}/documents`. */
  InsertBody: InsertBody
  /** The body of `POST /indexes/{name}/documents/_list`. */
  ListParams: ListParams
  /** The body of `POST /indexes/{name}/documents/_multi-get`. */
  MultiGetBody: MultiGetBody
  /** The body of `POST /indexes/{name}/partition-config`. */
  PartitionConfig: PartitionConfig
  /** The body of `POST /indexes/{name}/search` and of `POST /indexes/{name}/search/preflight`. */
  HttpQueryParams: HttpQueryParams
  /** The body of `POST /indexes/{name}/_rebalance`. */
  RebalanceBody: RebalanceBody
  /** The query string of `DELETE /indexes/{name}/documents/{id}`. */
  RemoveDocumentQuery: RemoveDocumentQuery
  /** The body of `PUT /indexes/{name}/replication-factor`. */
  ReplicationFactorBody: ReplicationFactorBody
  /** The body of `POST /indexes/{name}/suggest`. */
  SuggestParams: SuggestParams
  /** The query string of `GET /tasks`. */
  TaskListQuery: TaskListQuery
  /** The body of `POST /indexes/{name}/vectors/_compact` and of `POST /indexes/{name}/vectors/_optimize`. */
  VectorFieldBody: VectorFieldBody
  /** The body of `GET` and of `POST /indexes/{name}/synonyms`. */
  SynonymSetBody: SynonymSetBody
  /** The body of `POST /indexes/{name}/documents/_batch`. */
  BatchResponse: BatchResponse
  /** The body of `GET /capabilities`. */
  CapabilitiesResponse: CapabilitiesResponse
  /** The body of `GET /indexes/{name}/cluster`. */
  ClusterAllocationResponse: ClusterAllocationResponse
  /** The body of `GET /cluster/health`. */
  ClusterHealth: ClusterHealth
  /** The body of `GET /cluster`. */
  ClusterTopologyResponse: ClusterTopologyResponse
  /** The body of `GET /indexes/{name}/count`. */
  DocumentCountResponse: DocumentCountResponse
  /** The body of `GET /indexes/{name}/documents/{id}/_exists`. */
  DocumentExistsResponse: DocumentExistsResponse
  /** The body of `POST /indexes/{name}/documents` and of `PATCH /indexes/{name}/documents/{id}`. */
  DocumentIdResponse: DocumentIdResponse
  /** The body of `PUT /indexes/{name}/documents/{id}`. */
  DocumentPutResponse: DocumentPutResponse
  /** The body of `DELETE /indexes/{name}/documents/{id}`. */
  DocumentRemovedResponse: DocumentRemovedResponse
  /** The body of `GET /indexes/{name}/documents/{id}`. */
  DocumentResponse: DocumentResponse
  /** The body of every failed response. */
  ErrorEnvelope: ErrorEnvelope
  /** The body of `POST /indexes/{name}/search`. */
  HttpQueryResult: HttpQueryResult
  /** The body of `POST /indexes/{name}/documents/_import` when the server finishes the import inside the request. */
  ImportResult: ImportResult
  /** The body of `POST /indexes/{name}/_clear`. */
  IndexClearedResponse: IndexClearedResponse
  /** The body of `POST /indexes`. */
  IndexCreatedResponse: IndexCreatedResponse
  /** The body of `DELETE /indexes/{name}`. */
  IndexDroppedResponse: IndexDroppedResponse
  /** The body of `GET /indexes`. */
  IndexListResponse: IndexListResponse
  /** The body of `GET /indexes/{name}/partitions`. */
  IndexPartitionsResponse: IndexPartitionsResponse
  /** The body of `POST /indexes/{name}/_open` and of `POST /indexes/{name}/_close`. */
  IndexStateResponse: IndexStateResponse
  /** The body of `GET /indexes/{name}/stats`. */
  IndexStats: IndexStats
  /** The body of `GET /livez`. */
  LivenessResponse: LivenessResponse
  /** The body of `POST /indexes/{name}/documents/_list`. */
  ListResult: ListResult
  /** The body of `GET /stats/memory`. */
  MemoryStatsResponse: MemoryStatsResponse
  /** The body of `POST /indexes/{name}/documents/_multi-get`. */
  MultiGetResponse: MultiGetResponse
  /** The body of a request that the server finishes with nothing further to report. */
  OkResponse: OkResponse
  /** The body of `POST /indexes/{name}/search/preflight`. */
  PreflightResult: PreflightResult
  /** The body of `GET /readyz` and of `GET /health`. */
  ReadinessResponse: ReadinessResponse
  /** The body of `PUT /indexes/{name}/replication-factor`. */
  ReplicationFactorResponse: ReplicationFactorResponse
  /** The body of `POST /indexes/{name}/suggest`. */
  SuggestResult: SuggestResult
  /** The body of `GET /tasks`. */
  TaskListPage: TaskListPage
  /** The body of every route that starts a task, and of `GET /tasks/{id}`. */
  TaskRecord: TaskRecord
  /** The body of `GET /indexes/{name}/vector-maintenance`. */
  VectorMaintenanceResponse: VectorMaintenanceResponse
  /** The body of `GET /version`. */
  VersionResponse: VersionResponse
}

/**
 * The name of one schema in the published OpenAPI file.
 *
 * @public
 */
export type HttpWireTypeName = keyof HttpWireTypes
