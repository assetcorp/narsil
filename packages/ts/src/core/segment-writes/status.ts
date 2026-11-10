export class SegmentRefusal extends Error {
  constructor(readonly status: number) {
    super(`The keyword segment operation refused status ${status}`)
  }
}

export function requireSegment(condition: boolean): asserts condition {
  if (!condition) throw new SegmentRefusal(1)
}

export function requireRoom(condition: boolean): void {
  if (!condition) throw new SegmentRefusal(3)
}
