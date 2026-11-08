import type { NativeKeywordMergeInput, NativeSegmentMergeCore } from '../../vector/native/types/segment-merge'
import { requireRoom, requireSegment, SegmentRefusal } from '../segment-writes/status'
import type { MergePosting } from './plan'
import { captureInputs, MergeRegions, uint32 } from './regions'
import { sourcePosting } from './source'

function compareRows(left: MergePosting, right: MergePosting): number {
  return (
    left.target - right.target ||
    left.input.fieldMapping[left.field] - right.input.fieldMapping[right.field] ||
    left.source - right.source ||
    left.row - right.row
  )
}

function collect(inputs: readonly NativeKeywordMergeInput[], documents: number, fields: number): MergePosting[] {
  const rows: MergePosting[] = []
  let capacity = 0
  let ordered = true
  for (let source = 0; source < inputs.length; source++) {
    const input = inputs[source]
    capacity += input.postingDocuments.length
    requireSegment(input.growing == null && capacity <= 0xffffffff)
    for (let at = 0; at < input.postingDocuments.length; at++) {
      const document = input.postingDocuments[at]
      const field = input.postingFields[at]
      requireSegment(document < input.documentCount && field < input.fieldMapping.length)
      requireSegment(input.fieldMapping[field] < fields)
      if (input.positionOffsets !== null && input.positionValues !== null) {
        const start = input.positionOffsets[at]
        const end = input.positionOffsets[at + 1]
        requireSegment(start <= end && end <= input.positionValues.length)
        for (let position = start + 1; position < end; position++) {
          requireSegment(input.positionValues[position] >= input.positionValues[position - 1])
        }
      }
      if (input.mapping[document] === 0xffffffff) continue
      requireSegment(input.mapping[document] < documents)
      const row = sourcePosting(input, source, 0, at)
      requireSegment(row !== null)
      if (rows.length > 0 && compareRows(rows[rows.length - 1], row) > 0) ordered = false
      rows.push(row)
    }
  }
  if (!ordered) rows.sort(compareRows)
  return rows
}

export const mergePostings: NativeSegmentMergeCore['mergePostings'] = (
  rawInputs,
  documentCount,
  fieldCount,
  rawOutput,
) => {
  try {
    const captured = captureInputs(rawInputs)
    requireSegment(typeof rawOutput === 'object' && rawOutput !== null)
    const target = { ...rawOutput }
    uint32(documentCount)
    uint32(fieldCount)
    requireSegment(fieldCount <= 65536)
    const regions = new MergeRegions()
    const inputs = captured.map(input => regions.source(input))
    const documents = regions.read(target.documents, 'Uint32Array', undefined, true)
    const frequencies = regions.read(target.frequencies, 'Uint16Array', documents.length, true)
    const fields = regions.read(target.fields, 'Uint16Array', documents.length, true)
    const offsets = regions.read(target.positionOffsets, 'Uint32Array', undefined, true)
    const positions = regions.read(target.positions, 'Uint32Array', undefined, true)
    const totals = regions.read(target.totals, 'Float64Array', undefined, true)
    regions.check()
    const rows = collect(inputs, documentCount, fieldCount)
    let positionCount = 0
    let documentTotal = 0
    let frequencyTotal = 0
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at]
      positionCount += row.positionCount
      requireSegment(positionCount <= 0xffffffff)
      frequencyTotal += row.frequency
      if (at === 0 || row.target !== rows[at - 1].target) documentTotal++
      else {
        const before = rows[at - 1]
        requireSegment(
          row.source === before.source &&
            row.input.postingDocuments[row.row] === before.input.postingDocuments[before.row] &&
            row.input.fieldMapping[row.field] !== before.input.fieldMapping[before.field],
        )
      }
    }
    requireRoom(
      rows.length <= documents.length &&
        rows.length < offsets.length &&
        positionCount <= positions.length &&
        totals.length >= 2,
    )
    let next = 0
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at]
      documents[at] = row.target
      frequencies[at] = row.frequency
      fields[at] = row.input.fieldMapping[row.field]
      offsets[at] = next
      if (row.positions !== null) {
        positions.set(row.positions.subarray(row.positionStart, row.positionStart + row.positionCount), next)
        next += row.positionCount
      }
    }
    offsets[rows.length] = next
    totals[0] = documentTotal
    totals[1] = frequencyTotal
    return rows.length
  } catch (error) {
    if (error instanceof SegmentRefusal) return -error.status
    throw error
  }
}
