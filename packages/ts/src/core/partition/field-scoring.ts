import type { PartitionReadState } from './read-state'

export interface FieldScoring {
  searchable: Uint8Array
  boosts: Float64Array
  averageLengths: Float64Array
  lengthColumns: Array<Uint32Array | null>
}

export function loadFieldScoring(
  state: PartitionReadState,
  fields: readonly string[] | undefined,
  boost: Readonly<Record<string, number>> | undefined,
  averageFieldLengths: Readonly<Record<string, number>>,
): FieldScoring {
  const fieldNames = state.fieldNameTable.names
  const scoring: FieldScoring = {
    searchable: new Uint8Array(fieldNames.length),
    boosts: new Float64Array(fieldNames.length),
    averageLengths: new Float64Array(fieldNames.length),
    lengthColumns: new Array<Uint32Array | null>(fieldNames.length).fill(null),
  }
  for (let fieldIndex = 0; fieldIndex < fieldNames.length; fieldIndex++) {
    const fieldName = fieldNames[fieldIndex]
    scoring.searchable[fieldIndex] = fields === undefined || fields.includes(fieldName) ? 1 : 0
    scoring.boosts[fieldIndex] = boost?.[fieldName] ?? 1
    scoring.averageLengths[fieldIndex] = averageFieldLengths[fieldName] ?? 1
    scoring.lengthColumns[fieldIndex] = state.docStore.fieldLengthColumn(fieldName)
  }
  return scoring
}

export function fieldLengthOf(
  columns: ReadonlyArray<Uint32Array | null>,
  fieldIndex: number,
  internalId: number,
  averageLength: number,
): number {
  const column = fieldIndex < columns.length ? columns[fieldIndex] : null
  if (column === null || internalId >= column.length) return averageLength
  const stored = column[internalId]
  return stored > 0 ? stored : averageLength
}

export function bestSearchable(searchable: Uint8Array, values: Float64Array): number {
  let best = 0
  for (let index = 0; index < searchable.length; index++) {
    if (searchable[index] === 1 && values[index] > best) best = values[index]
  }
  return best
}
