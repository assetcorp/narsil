import type { FacetResult } from '../../types/results'
import type { SchemaDefinition } from '../../types/schema'
import type { FacetConfig } from '../../types/search'
import { getFieldValueForDoc, getFlatSchema, type PartitionState } from './utils'

export function computeFacets(
  state: PartitionState,
  docIds: Set<string>,
  config: FacetConfig,
  schema: SchemaDefinition,
): Record<string, FacetResult> {
  const result: Record<string, FacetResult> = {}
  const flatSchema = getFlatSchema(state, schema)

  for (const [fieldPath, facetOpts] of Object.entries(config)) {
    const fieldType = flatSchema[fieldPath]
    if (!fieldType) continue

    const valueCounts = new Map<string, number>()

    if (facetOpts.ranges && (fieldType === 'number' || fieldType === 'number[]')) {
      for (const range of facetOpts.ranges) {
        const label = `${range.from}-${range.to}`
        let count = 0
        for (const docId of docIds) {
          const val = getFieldValueForDoc(state.docStore, docId, fieldPath)
          if (fieldType === 'number[]' && Array.isArray(val)) {
            for (const v of val as number[]) {
              if (v >= range.from && v < range.to) {
                count++
                break
              }
            }
          } else if (typeof val === 'number' && val >= range.from && val < range.to) {
            count++
          }
        }
        valueCounts.set(label, count)
      }
    } else {
      for (const docId of docIds) {
        const val = getFieldValueForDoc(state.docStore, docId, fieldPath)
        if (val === undefined || val === null) continue

        if (Array.isArray(val)) {
          for (const item of val) {
            const key = String(item)
            valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1)
          }
        } else {
          const key = String(val)
          valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1)
        }
      }
    }

    let entries = Array.from(valueCounts.entries())
    const sortDir = facetOpts.sort ?? 'desc'
    entries.sort((a, b) => (sortDir === 'asc' ? a[1] - b[1] : b[1] - a[1]))

    if (facetOpts.limit && facetOpts.limit > 0) {
      entries = entries.slice(0, facetOpts.limit)
    }

    const values: Record<string, number> = {}
    for (const [key, count] of entries) {
      values[key] = count
    }

    result[fieldPath] = { values, count: entries.length }
  }

  return result
}
