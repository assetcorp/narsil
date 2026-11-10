import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput, NativeKeywordMergeOutput } from '../../vector/native/types/segment-merge'
import type { KeywordMergePlan } from './plan'
import type { MergeString } from './strings'

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

function positions(plan: KeywordMergePlan, offsets: Uint32Array, values: Uint32Array): void {
  const { rows } = plan
  let positionAt = 0
  for (let row = 0; row < rows.count; row++) {
    offsets[row] = positionAt
    const count = rows.positionCounts[row]
    const source = rows.positionValues[rows.sources[row]]
    if (count === 0 || source === null) continue
    const start = rows.positionStarts[row]
    for (let at = 0; at < count; at++) values[positionAt + at] = source[start + at]
    positionAt += count
  }
  offsets[rows.count] = positionAt
}

function postings(plan: KeywordMergePlan, output: NativeKeywordMergeOutput): void {
  const { rows } = plan
  let termAt = 0
  let textAt = 0
  output.terms.offsets[0] = 0
  output.postingOffsets[0] = 0
  for (const term of plan.terms) {
    output.terms.text.set(term.bytes, textAt)
    textAt += term.bytes.length
    output.terms.counts[termAt] = term.documents
    output.terms.offsets[++termAt] = textAt
    output.postingOffsets[termAt] = term.rowEnd
  }
  output.postingDocuments.set(rows.targets.subarray(0, rows.count))
  output.postingFrequencies.set(rows.frequencies.subarray(0, rows.count))
  output.postingFields.set(rows.fields.subarray(0, rows.count))
  if (plan.hasPositions && output.positionOffsets !== null && output.positionValues !== null) {
    positions(plan, output.positionOffsets, output.positionValues)
  }
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
