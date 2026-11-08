import { regionsOverlap } from '../core/regions'

function saturate(score: number): number {
  if (score > Number.MAX_VALUE) return Number.MAX_VALUE
  if (score < -Number.MAX_VALUE) return -Number.MAX_VALUE
  return score
}

function scoreRange(keys: Uint32Array, scores: Float64Array, keyCount: number): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let position = 0; position < keys.length; position++) {
    if (keys[position] >= keyCount) continue
    const score = saturate(scores[position])
    if (score < min) min = score
    if (score > max) max = score
  }
  return { min, max }
}

class FusionScratch {
  readonly seen: Uint8Array
  readonly touched: number[] = []
  readonly text: Float64Array
  readonly vector: Float64Array

  constructor(readonly capacity: number) {
    this.seen = new Uint8Array(capacity)
    this.text = new Float64Array(capacity)
    this.vector = new Float64Array(capacity)
  }
}

let available: FusionScratch | undefined

function recordKey(scratch: FusionScratch, key: number, bit: number): boolean {
  const seen = scratch.seen[key]
  if ((seen & bit) !== 0) return false
  if (seen === 0) scratch.touched.push(key)
  scratch.seen[key] = seen | bit
  return true
}

function addRanks(scratch: FusionScratch, keys: Uint32Array, count: number, bit: number, k: number): boolean {
  const totals = scratch.text
  for (let position = 0; position < keys.length; position++) {
    const key = keys[position]
    if (key >= count) continue
    if (!recordKey(scratch, key, bit)) return false
    totals[key] += 1 / (k + position + 1)
  }
  return true
}

function addScores(
  scratch: FusionScratch,
  keys: Uint32Array,
  scores: Float64Array,
  count: number,
  bit: number,
  totals: Float64Array,
): boolean {
  const { min, max } = scoreRange(keys, scores, count)
  const width = max - min
  for (let position = 0; position < keys.length; position++) {
    const key = keys[position]
    if (key >= count) continue
    if (!recordKey(scratch, key, bit)) return false
    const score = saturate(scores[position])
    if (Number.isNaN(score)) totals[key] = 0
    else if (width === 0) totals[key] = 1
    else if (Number.isFinite(width)) totals[key] = (score - min) / width
    else totals[key] = (score / 2 - min / 2) / (max / 2 - min / 2)
  }
  return true
}

export function fuse(
  strategy: number,
  k: number,
  alpha: number,
  textKeys: Uint32Array,
  textScores: Float64Array,
  vectorKeys: Uint32Array,
  vectorScores: Float64Array,
  idRanks: Uint32Array,
  keys: Uint32Array,
  scores: Float64Array,
): number {
  if (
    (strategy !== 0 && strategy !== 1) ||
    !Number.isInteger(k) ||
    k < 1 ||
    !Number.isFinite(alpha) ||
    alpha < 0 ||
    alpha > 1 ||
    textKeys.length !== textScores.length ||
    vectorKeys.length !== vectorScores.length
  ) {
    return -1
  }
  const capacity = Math.min(keys.length, scores.length)
  const writtenKeys = keys.length === capacity ? keys : keys.subarray(0, capacity)
  const writtenScores = scores.length === capacity ? scores : scores.subarray(0, capacity)
  const keyBuffer = writtenKeys.buffer
  const scoreBuffer = writtenScores.buffer
  if (keyBuffer === scoreBuffer && regionsOverlap(writtenKeys, writtenScores)) return -1
  for (const input of [textKeys, textScores, vectorKeys, vectorScores, idRanks]) {
    const buffer = input.buffer
    if (
      (keyBuffer === buffer && regionsOverlap(writtenKeys, input)) ||
      (scoreBuffer === buffer && regionsOverlap(writtenScores, input))
    )
      return -1
  }
  const count = idRanks.length
  const held = available
  available = undefined
  const scratch = held === undefined || held.capacity < count ? new FusionScratch(count) : held
  const { seen, touched, text, vector } = scratch
  touched.length = 0
  seen.fill(0, 0, count)
  text.fill(0, 0, count)
  if (strategy === 1) vector.fill(0, 0, count)
  try {
    const valid =
      strategy === 0
        ? addRanks(scratch, textKeys, count, 1, k) && addRanks(scratch, vectorKeys, count, 2, k)
        : addScores(scratch, textKeys, textScores, count, 1, text) &&
          addScores(scratch, vectorKeys, vectorScores, count, 2, vector)
    if (!valid) return -1
    const found = touched.length
    if (found > keys.length || found > scores.length) return -3
    if (strategy === 1) {
      for (let position = 0; position < found; position++) {
        const key = touched[position]
        text[key] = alpha * vector[key] + (1 - alpha) * text[key]
      }
    }
    touched.sort((left, right) => text[right] - text[left] || idRanks[left] - idRanks[right])
    for (let position = 0; position < found; position++) {
      const key = touched[position]
      keys[position] = key
      scores[position] = text[key]
    }
    return found
  } finally {
    available = scratch
  }
}
