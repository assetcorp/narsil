import { compareScores } from '../core/ordering/scores'
import { typedRegion } from '../core/stored-values/regions'

export function pageStart(
  count: number,
  sorted: boolean,
  scores: Float64Array | null,
  scorePresent: Uint32Array | null,
  afterAnchor: Uint32Array,
  anchorScore: number | null,
): number {
  const scoreRegion = scores === null ? null : typedRegion(scores, 'Float64Array')
  const presentRegion = scorePresent === null ? null : typedRegion(scorePresent, 'Uint32Array')
  const afterRegion = typedRegion(afterAnchor, 'Uint32Array')
  const words = Math.max(1, Math.ceil(count / 32))
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    count > 0xffffffff ||
    typeof sorted !== 'boolean' ||
    (anchorScore !== null && typeof anchorScore !== 'number') ||
    afterRegion === null ||
    afterRegion.length < words ||
    (scores === null ? scorePresent !== null : scoreRegion === null || scoreRegion.length !== count) ||
    (scorePresent !== null && (presentRegion === null || presentRegion.length < words))
  ) {
    return -1
  }
  for (let position = 0; position < count; position++) {
    const word = position >>> 5
    const mask = 1 << (position & 31)
    const after = (afterRegion[word] & mask) !== 0
    if (sorted) {
      if (after) return position
    } else {
      if (
        anchorScore === null ||
        scoreRegion === null ||
        (presentRegion !== null && (presentRegion[word] & mask) === 0)
      ) {
        return position
      }
      const order = compareScores(scoreRegion[position], anchorScore)
      if (order > 0 || (order === 0 && after)) return position
    }
  }
  return count
}
