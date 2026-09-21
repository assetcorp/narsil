import type { SegmentPayload } from './segment-payload'
import type { PartitionReadState } from './utils'

export type SegmentFieldIndexes = Pick<
  PartitionReadState,
  'numericIndexes' | 'booleanIndexes' | 'enumIndexes' | 'geoIndexes'
>

export function encodeFieldIndexes(
  state: SegmentFieldIndexes,
  remap: Int32Array,
): Pick<SegmentPayload, 'numeric' | 'boolean' | 'enums' | 'geo'> {
  const survives = (internalId: number): boolean => remap[internalId] >= 0

  const numeric: SegmentPayload['numeric'] = []
  for (const [fieldPath, index] of state.numericIndexes) {
    const entries = index.serialize().filter(entry => survives(entry.docId))
    const docIds = new Uint32Array(entries.length)
    const values = new Float64Array(entries.length)
    for (let i = 0; i < entries.length; i++) {
      docIds[i] = remap[entries[i].docId]
      values[i] = entries[i].value
    }
    numeric.push({ fieldPath, docIds, values })
  }

  const booleans: SegmentPayload['boolean'] = []
  for (const [fieldPath, index] of state.booleanIndexes) {
    const { trueDocs, falseDocs } = index.serialize()
    booleans.push({
      fieldPath,
      trueDocs: Uint32Array.from(trueDocs.filter(survives), internalId => remap[internalId]),
      falseDocs: Uint32Array.from(falseDocs.filter(survives), internalId => remap[internalId]),
    })
  }

  const enums: SegmentPayload['enums'] = []
  for (const [fieldPath, index] of state.enumIndexes) {
    const serialized = index.serialize()
    const values = Object.keys(serialized)
    const byValue = values.map(value => serialized[value].filter(survives))
    const offsets = new Uint32Array(values.length + 1)
    let total = 0
    for (let i = 0; i < values.length; i++) {
      total += byValue[i].length
      offsets[i + 1] = total
    }
    const docIds = new Uint32Array(total)
    let cursor = 0
    for (const survivors of byValue) {
      for (const internalId of survivors) docIds[cursor++] = remap[internalId]
    }
    enums.push({ fieldPath, values, offsets, docIds })
  }

  const geo: SegmentPayload['geo'] = []
  for (const [fieldPath, index] of state.geoIndexes) {
    const entries = index.serialize().filter(entry => survives(entry.docId))
    const docIds = new Uint32Array(entries.length)
    const latitudes = new Float64Array(entries.length)
    const longitudes = new Float64Array(entries.length)
    for (let i = 0; i < entries.length; i++) {
      docIds[i] = remap[entries[i].docId]
      latitudes[i] = entries[i].lat
      longitudes[i] = entries[i].lon
    }
    geo.push({ fieldPath, docIds, latitudes, longitudes })
  }

  return { numeric, boolean: booleans, enums, geo }
}
