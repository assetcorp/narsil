import type { PreparedTextChange } from './prepared-text'

export class SegmentFull extends Error {
  constructor(readonly text: PreparedTextChange) {
    super('The document needs a new keyword segment')
  }
}
