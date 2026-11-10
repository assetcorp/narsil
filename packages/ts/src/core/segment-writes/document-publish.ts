import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import type { PreparedSegmentField } from './prepared-tokens'
import { publishSurfaces, type StringPlan } from './strings'

const NO_TEXTS: readonly string[] = []

export function sharedTexts(fields: readonly PreparedSegmentField[]): readonly string[] | null {
  let texts: readonly string[] | null = fields.length === 0 ? NO_TEXTS : null
  for (const { text } of fields) {
    if (text.texts === null || (texts !== null && text.texts !== texts)) return null
    texts = text.texts
  }
  return texts
}

export function grownWords(held: Uint32Array, capacity: number): Uint32Array<ArrayBuffer> {
  const grown = new Uint32Array(capacity)
  grown.set(held)
  return grown
}

export function grownBytes(held: Uint8Array, capacity: number): Uint8Array<ArrayBuffer> {
  const grown = new Uint8Array(capacity)
  grown.set(held)
  return grown
}

export function publishSurfaceCounts(plan: StringPlan | null, segment: NativeGrowingSegment): void {
  const table = segment.surfaces
  if (plan === null || table === null) return
  publishSurfaces(plan, table)
  const occurrences = segment.columns.surfaceOccurrences
  const terms = segment.terms.header[0]
  for (let at = 0; at < plan.size; at++) {
    const token = plan.tokens[at]
    if (token < terms) occurrences[token] += plan.counts[at]
  }
}

export function publishFieldLengths(
  segment: NativeGrowingSegment,
  document: number,
  fields: readonly PreparedSegmentField[],
): void {
  const capacity = segment.ordinalCapacity
  for (let field = 0; field < segment.partialFields.length; field++)
    segment.fieldLengths[field * capacity + document] = 0
  for (const { field, text } of fields) {
    segment.fieldLengths[field * capacity + document] = text.count
    segment.totalFieldLengths[field] += text.count
  }
  segment.totalDocuments[0]++
}
