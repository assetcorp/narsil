import { applyProjection, resolveProjection, type VectorReadSettings } from '../../../core/projection'
import { readSortValues } from '../../../search/sort-keys'
import { normalizeSort, sortModesOf } from '../../../search/sorting'
import type { AnyDocument } from '../../../types/schema'
import type { ListParams } from '../../../types/search'
import type { ListEntryWire, ListPayload } from '../../transport/types'
import type { ClusterLocalEngine } from '../local-engine'

export interface LocalListPage {
  entries: ListEntryWire[]
  total: number
  hasMore: boolean
}

const VECTORS_CHOSEN_BY_THE_LIST: VectorReadSettings = { schema: {} }

function toWireSortValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return null
}

function fieldsToList(fields: string[] | null, sortFieldNames: string[] | null): string[] | null {
  if (fields === null || fields.length === 0 || sortFieldNames === null) return fields
  const listed = new Set(fields)
  for (const sortField of sortFieldNames) listed.add(sortField)
  return listed.size === fields.length ? fields : Array.from(listed)
}

export async function listLocalPage(engine: ClusterLocalEngine, payload: ListPayload): Promise<LocalListPage> {
  const normalizedSort = payload.sort === null ? null : normalizeSort(payload.sort)
  const sortFieldNames = normalizedSort === null ? null : normalizedSort.map(entry => entry.field)
  const sortModes = normalizedSort === null ? [] : sortModesOf(normalizedSort)
  const listedFields = fieldsToList(payload.fields, sortFieldNames)
  const answerProjection =
    listedFields === payload.fields || payload.fields === null
      ? null
      : resolveProjection({ include: payload.fields }, VECTORS_CHOSEN_BY_THE_LIST)

  const listParams: ListParams = {
    cursor: payload.cursor ?? undefined,
    limit: payload.limit,
    filters: payload.filters ?? undefined,
    sort: payload.sort ?? undefined,
    document: { ...(listedFields === null ? {} : { include: listedFields }), vectors: payload.vectors !== false },
  }
  const result = await engine.listPartitions(payload.indexName, listParams, payload.partitionIds)
  const entries: ListEntryWire[] = result.documents.map(listed => {
    const stored = listed.document as AnyDocument | undefined
    return {
      docId: listed.id,
      document: (answerProjection === null || stored === undefined
        ? stored
        : applyProjection(stored, answerProjection)) as Record<string, unknown>,
      sortValues:
        sortFieldNames === null ? null : readSortValues(stored, sortFieldNames, sortModes).map(toWireSortValue),
    }
  })
  return { entries, total: result.total, hasMore: result.cursor !== null }
}
