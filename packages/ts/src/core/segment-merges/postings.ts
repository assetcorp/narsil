import { captureInputs, requireRoom, requireSegment, SegmentRefusal, uint32 } from '#platform/segment-merge-host'
import type { NativeKeywordMergeInput, NativeSegmentMergeCore } from '../../vector/native/types/segment-merge'
import { preparePostings, preparePostingsInContext } from './posting-context'
import { PostingRows } from './posting-rows'

const scratch = new PostingRows()

function allFrozen(inputs: readonly NativeKeywordMergeInput[]): boolean {
  for (const input of inputs) if (input.growing != null) return false
  return true
}

function collect(inputs: readonly NativeKeywordMergeInput[], documents: number, fields: number): PostingRows {
  let capacity = 0
  for (const input of inputs) {
    capacity += input.postingDocuments.length
    requireSegment(input.growing == null && capacity <= 0xffffffff)
  }
  scratch.reset(capacity)
  for (let source = 0; source < inputs.length; source++) {
    const { postingDocuments, postingFields, documentCount, fieldMapping, mapping, positionOffsets, positionValues } =
      inputs[source]
    for (let at = 0; at < postingDocuments.length; at++) {
      const document = postingDocuments[at]
      const field = postingFields[at]
      requireSegment(document < documentCount && field < fieldMapping.length)
      const mapped = fieldMapping[field]
      requireSegment(mapped < fields)
      if (positionOffsets !== null && positionValues !== null) {
        const start = positionOffsets[at]
        const end = positionOffsets[at + 1]
        requireSegment(start <= end && end <= positionValues.length)
        for (let position = start + 1; position < end; position++) {
          requireSegment(positionValues[position] >= positionValues[position - 1])
        }
      }
      const target = mapping[document]
      if (target === 0xffffffff) continue
      requireSegment(target < documents)
      scratch.push(target, mapped, source, at)
    }
  }
  return scratch
}

function positionCountOf(input: NativeKeywordMergeInput, row: number): number {
  const { positionOffsets, positionValues } = input
  return positionOffsets === null || positionValues === null ? 0 : positionOffsets[row + 1] - positionOffsets[row]
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
    const { inputs, outputs } = allFrozen(captured)
      ? preparePostingsInContext(rawOutput, target, rawInputs, captured)
      : preparePostings(target, captured)
    const { documents, frequencies, fields, offsets, positions, totals } = outputs
    const rows = collect(inputs, documentCount, fieldCount)
    const order = rows.sequence()
    const { targets, sources } = rows
    let positionCount = 0
    let documentTotal = 0
    let frequencyTotal = 0
    for (let at = 0; at < order.length; at++) {
      const row = order[at]
      const input = inputs[sources[row]]
      const read = rows.rows[row]
      positionCount += positionCountOf(input, read)
      requireSegment(positionCount <= 0xffffffff)
      frequencyTotal += input.postingFrequencies[read]
      if (at === 0 || targets[row] !== targets[order[at - 1]]) documentTotal++
      else {
        const before = order[at - 1]
        requireSegment(
          sources[row] === sources[before] &&
            input.postingDocuments[read] === inputs[sources[before]].postingDocuments[rows.rows[before]] &&
            rows.fields[row] !== rows.fields[before],
        )
      }
    }
    requireRoom(
      order.length <= documents.length &&
        order.length < offsets.length &&
        positionCount <= positions.length &&
        totals.length >= 2,
    )
    let next = 0
    for (let at = 0; at < order.length; at++) {
      const row = order[at]
      const input = inputs[sources[row]]
      const read = rows.rows[row]
      documents[at] = targets[row]
      frequencies[at] = input.postingFrequencies[read]
      fields[at] = rows.fields[row]
      offsets[at] = next
      const { positionOffsets, positionValues } = input
      if (positionOffsets !== null && positionValues !== null) {
        const end = positionOffsets[read + 1]
        for (let position = positionOffsets[read]; position < end; position++)
          positions[next++] = positionValues[position]
      }
    }
    offsets[order.length] = next
    totals[0] = documentTotal
    totals[1] = frequencyTotal
    return order.length
  } catch (error) {
    if (error instanceof SegmentRefusal) return -error.status
    throw error
  }
}
