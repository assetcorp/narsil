import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput, NativeKeywordMergeOutput } from '../../vector/native/types/segment-merge'
import { requireRoom } from '../segment-writes/status'
import type { KeywordMergePlan } from './plan'
import type { MergeString } from './strings'

function fits(table: NativeFrozenStrings, count: number, bytes: number, stride: number): boolean {
  return table.counts.length >= count && table.text.length >= bytes && table.offsets.length >= count * stride + 1
}

export function checkCapacity(
  plan: KeywordMergePlan,
  documentCount: number,
  fieldCount: number,
  output: NativeKeywordMergeOutput,
): void {
  const sizes = plan.sizes
  requireRoom(
    fits(output.terms, sizes[0], sizes[1], 1) &&
      fits(output.surfaces, sizes[5], sizes[6], 2) &&
      fits(output.spellings, sizes[7], sizes[8], 2) &&
      output.postingOffsets.length > sizes[0] &&
      output.postingDocuments.length >= sizes[2] &&
      output.fieldLengths.length >= documentCount * fieldCount &&
      output.totalFieldLengths.length >= fieldCount &&
      (!plan.hasPositions ||
        (output.positionOffsets !== null &&
          output.positionValues !== null &&
          output.positionOffsets.length > sizes[2] &&
          output.positionValues.length >= sizes[3])),
  )
}

function strings(entries: readonly MergeString[], output: NativeFrozenStrings): void {
  let written = 0
  output.offsets[0] = 0
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at]
    output.text.set(entry.spellingBytes, written)
    written += entry.spellingBytes.length
    output.offsets[at * 2 + 1] = written
    output.text.set(entry.tokenBytes, written)
    written += entry.tokenBytes.length
    output.offsets[at * 2 + 2] = written
    output.counts[at] = entry.count
  }
}

function postings(plan: KeywordMergePlan, output: NativeKeywordMergeOutput): void {
  let termAt = 0
  let textAt = 0
  let rowAt = 0
  let positionAt = 0
  output.terms.offsets[0] = 0
  output.postingOffsets[0] = 0
  for (const term of plan.terms) {
    output.terms.text.set(term.bytes, textAt)
    textAt += term.bytes.length
    output.terms.counts[termAt] = term.documents
    for (const row of term.postings) {
      output.postingDocuments[rowAt] = row.target
      output.postingFrequencies[rowAt] = row.frequency
      output.postingFields[rowAt] = row.input.fieldMapping[row.field]
      if (plan.hasPositions && output.positionOffsets !== null && output.positionValues !== null) {
        output.positionOffsets[rowAt] = positionAt
        const source = row.positions
        if (source !== null) {
          for (let at = 0; at < row.positionCount; at++)
            output.positionValues[positionAt++] = source[row.positionStart + at]
        }
      }
      rowAt++
    }
    output.terms.offsets[++termAt] = textAt
    output.postingOffsets[termAt] = rowAt
  }
  if (plan.hasPositions && output.positionOffsets !== null) output.positionOffsets[rowAt] = positionAt
}

export function publishMerge(
  plan: KeywordMergePlan,
  inputs: readonly NativeKeywordMergeInput[],
  documentCount: number,
  fieldCount: number,
  output: NativeKeywordMergeOutput,
): void {
  postings(plan, output)
  strings(plan.surfaces, output.surfaces)
  strings(plan.spellings, output.spellings)
  output.fieldLengths.fill(0, 0, documentCount * fieldCount)
  output.totalFieldLengths.fill(0, 0, fieldCount)
  for (const input of inputs) {
    for (let field = 0; field < input.fieldLengths.length; field++) {
      const lengths = input.fieldLengths[field]
      if (lengths === null) continue
      const targetField = input.fieldMapping[field]
      for (let ordinal = 0; ordinal < input.documentCount; ordinal++) {
        const target = input.mapping[ordinal]
        if (target === 0xffffffff) continue
        output.fieldLengths[targetField * documentCount + target] = lengths[ordinal]
        output.totalFieldLengths[targetField] += lengths[ordinal]
      }
    }
  }
}
