import { buildStoredValues } from '../../core/stored-values/build'
import { requireLoadedOptionalReads } from '../../engine/optional-reads-code'
import { ErrorCodes, NarsilError } from '../../errors'
import type { WireGroupEntry } from '../transport/types'

function groupValueOf(values: Record<string, unknown>, field: string): unknown {
  return Object.hasOwn(values, field) ? (values[field] ?? null) : null
}

export function groupIdentities(
  sources: readonly WireGroupEntry[],
  fields: readonly string[],
): { keys: Uint32Array; values: Array<Record<string, unknown>> } {
  const count = sources.length
  const stored = fields.map(field => buildStoredValues(sources.map(source => groupValueOf(source.values, field))))
  const ordinals = Uint32Array.from(sources, (_, position) => position)
  const scores = new Float64Array(count)
  const heads = new Uint32Array(count)
  const offsets = new Uint32Array(count + 1)
  const positions = new Uint32Array(count)
  const members = new Uint32Array(count)
  const found = requireLoadedOptionalReads().groupHits(
    stored,
    ordinals,
    scores,
    ordinals,
    count,
    null,
    heads,
    offsets,
    positions,
    members,
  )
  if (found < 0)
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The group values cannot be compared', { status: found })
  const keys = new Uint32Array(count)
  const values = new Array<Record<string, unknown>>(found)
  for (let group = 0; group < found; group++) {
    const head = sources[heads[group]].values
    const named: Record<string, unknown> = Object.create(null)
    for (const field of fields) named[field] = groupValueOf(head, field)
    values[group] = named
    for (let at = offsets[group]; at < offsets[group + 1]; at++) keys[positions[at]] = group
  }
  return { keys, values }
}
