import type { NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'

export const PENDING_DOCUMENTS = 0
export const PENDING_TOKENS = 1
export const PENDING_UNITS = 2
export const PENDING_HEADER_WORDS = 8
export const PENDING_TOKEN_WORDS = 5

export interface PendingSize {
  documents: number
  tokens: number
  units: number
}

export function pendingSettled(state: Pick<NativeFrozenSegmentState, 'pendingHeader'>): boolean {
  const header = state.pendingHeader
  return header[PENDING_DOCUMENTS] === 0 && header[PENDING_TOKENS] === 0 && header[PENDING_UNITS] === 0
}
