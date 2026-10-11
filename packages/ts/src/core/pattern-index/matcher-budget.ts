import {
  MATCHER_CODE_POINT_BYTES,
  MATCHER_SIMULATION_BYTES_PER_POSITION,
  MATCHER_STATE_BUDGET_BYTES,
  MATCHER_STATE_OVERHEAD_BYTES,
} from './constants'

const POSITIONS_PER_WORD = 32

export function positionWords(positions: number): number {
  return Math.max(1, Math.ceil(positions / POSITIONS_PER_WORD))
}

export function automatonBytes(positions: number): number {
  return 2 * positionWords(positions) * Uint32Array.BYTES_PER_ELEMENT + positions * MATCHER_CODE_POINT_BYTES
}

export function smallestMatcherBytes(positions: number): number {
  return (
    automatonBytes(positions) +
    positions * MATCHER_SIMULATION_BYTES_PER_POSITION +
    MATCHER_STATE_OVERHEAD_BYTES +
    positions * Uint32Array.BYTES_PER_ELEMENT
  )
}

export function widestPatternSplit(positions: number): number {
  return Math.max(1, Math.floor(MATCHER_STATE_BUDGET_BYTES / smallestMatcherBytes(positions)))
}
