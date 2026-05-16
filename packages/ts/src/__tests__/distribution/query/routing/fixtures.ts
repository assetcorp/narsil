import { encode } from '@msgpack/msgpack'
import type { AllocationTable, PartitionAssignment } from '../../../../distribution/coordinator/types'
import {
  createInMemoryTransport,
  type InMemoryNetwork,
  type NodeTransport,
  QueryMessageTypes,
} from '../../../../distribution/transport'
import type {
  SearchResultPayload,
  StatsResultPayload,
  TransportMessage,
  WireQueryParams,
} from '../../../../distribution/transport/types'

export function makeAssignment(overrides: Partial<PartitionAssignment> = {}): PartitionAssignment {
  return {
    primary: 'node-a',
    replicas: [],
    inSyncSet: ['node-a'],
    state: 'ACTIVE',
    primaryTerm: 1,
    ...overrides,
  }
}

export function makeAllocationTable(
  assignments: Array<[number, PartitionAssignment]>,
  indexName = 'products',
): AllocationTable {
  return {
    indexName,
    version: 1,
    replicationFactor: 1,
    assignments: new Map(assignments),
  }
}

export function makeQueryParams(overrides: Partial<WireQueryParams> = {}): WireQueryParams {
  return {
    term: 'test query',
    filters: null,
    sort: null,
    group: null,
    facets: null,
    facetSize: null,
    limit: 10,
    offset: 0,
    searchAfter: null,
    fields: null,
    boost: null,
    tolerance: null,
    threshold: null,
    scoring: 'local',
    vector: null,
    hybrid: null,
    ...overrides,
  }
}

export function makeSearchResultResponse(
  partitionResults: Array<{ partitionId: number; scored: Array<{ docId: string; score: number }>; totalHits: number }>,
  facets: Record<string, Array<{ value: string; count: number }>> | null = null,
): SearchResultPayload {
  return {
    results: partitionResults.map(r => ({
      partitionId: r.partitionId,
      scored: r.scored.map(s => ({ docId: s.docId, score: s.score, sortValues: null })),
      totalHits: r.totalHits,
    })),
    facets,
  }
}

export function createSearchResultMessage(
  payload: SearchResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.SEARCH_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function createStatsResultMessage(
  payload: StatsResultPayload,
  sourceId: string,
  requestId: string,
): TransportMessage {
  return {
    type: QueryMessageTypes.STATS_RESULT,
    sourceId,
    requestId,
    payload: encode(payload),
  }
}

export function setupDataNode(
  network: InMemoryNetwork,
  transports: NodeTransport[],
  nodeId: string,
  handler: (msg: TransportMessage, respond: (r: TransportMessage) => void) => void,
): NodeTransport {
  const transport = createInMemoryTransport(nodeId, network)
  transports.push(transport)
  transport.listen(handler)
  return transport
}
