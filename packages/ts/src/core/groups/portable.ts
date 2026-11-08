import type { NativeGroupCore } from '../../vector/native/types/groups'
import { compareScores } from '../ordering/scores'
import { regionsOverlap } from '../regions'
import { compareStoredValues } from '../stored-values/compare'
import { readStoredFields, validStoredValue } from '../stored-values/read'
import { typedRegion } from '../stored-values/regions'

function unsigned(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

export const groupHits: NativeGroupCore['groupHits'] = (
  values,
  inputOrdinals,
  inputScores,
  inputIdRanks,
  maxPerGroup,
  limit,
  outputHeads,
  outputOffsets,
  outputHits,
  outputMembers,
) => {
  if (!unsigned(maxPerGroup) || (limit !== null && !unsigned(limit))) return -1
  const fields = readStoredFields(values)
  const ordinals = typedRegion(inputOrdinals, 'Uint32Array')
  const scores = typedRegion(inputScores, 'Float64Array')
  const idRanks = typedRegion(inputIdRanks, 'Uint32Array')
  const outHeads = typedRegion(outputHeads, 'Uint32Array')
  const outOffsets = typedRegion(outputOffsets, 'Uint32Array')
  const outHits = typedRegion(outputHits, 'Uint32Array')
  const outMembers = typedRegion(outputMembers, 'Uint32Array')
  if (
    fields === null ||
    ordinals === null ||
    scores === null ||
    idRanks === null ||
    outHeads === null ||
    outOffsets === null ||
    outHits === null ||
    outMembers === null ||
    !unsigned(ordinals.length) ||
    scores.length !== ordinals.length ||
    idRanks.length !== ordinals.length
  )
    return -1
  const inputs: ArrayBufferView[] = [ordinals, scores, idRanks]
  for (const field of fields) inputs.push(...Object.values(field))
  const outputs = [outHeads, outOffsets, outHits, outMembers]
  for (let target = 0; target < outputs.length; target++) {
    if (inputs.some(input => regionsOverlap(outputs[target], input))) return -1
    for (let prior = 0; prior < target; prior++) if (regionsOverlap(outputs[target], outputs[prior])) return -1
  }
  const compare = (left: number, right: number): number => {
    for (const field of fields) {
      const order = compareStoredValues(field, ordinals[left], ordinals[right])
      if (order !== 0) return order
    }
    return 0
  }
  const positions: number[] = []
  for (let at = 0; at < ordinals.length; at++) {
    if (fields.every(field => validStoredValue(field, ordinals[at]))) positions.push(at)
  }
  positions.sort((left, right) => compare(left, right) || left - right)
  const groups: Array<{ first: number; end: number; head: number }> = []
  for (let first = 0; first < positions.length; ) {
    let end = first + 1
    while (end < positions.length && compare(positions[first], positions[end]) === 0) end++
    groups.push({ first, end, head: positions[first] })
    first = end
  }
  groups.sort(
    (left, right) =>
      compareScores(scores[left.head], scores[right.head]) ||
      idRanks[left.head] - idRanks[right.head] ||
      left.head - right.head,
  )
  const count = Math.min(limit ?? groups.length, groups.length)
  if (outHeads.length < count || outMembers.length < count || outOffsets.length < count + 1) return -3
  let needed = 0
  for (let at = 0; at < count; at++) needed += Math.min(maxPerGroup, groups[at].end - groups[at].first)
  if (outHits.length < needed) return -3
  let position = 0
  outOffsets[0] = 0
  for (let at = 0; at < count; at++) {
    const group = groups[at]
    const retained = Math.min(maxPerGroup, group.end - group.first)
    outHeads[at] = group.head
    outMembers[at] = group.end - group.first
    for (let member = 0; member < retained; member++) outHits[position++] = positions[group.first + member]
    outOffsets[at + 1] = position
  }
  return count
}
