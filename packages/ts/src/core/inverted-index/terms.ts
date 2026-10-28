import { NO_SLICE } from './pools'

export const TERM_LIVE = 1
export const TERM_ORDERED = 2
export const TERM_POSITIONS = 4

interface Bucket {
  ordinals: Uint32Array
  length: number
  dead: number
}

function grow<T extends Uint32Array | Uint8Array | Float64Array>(source: T, target: T): T {
  target.set(source)
  return target
}

export class TermColumns {
  ids = new Map<string, number>()
  tokens: string[] = []
  sliceStart: Uint32Array
  sliceClass: Uint8Array
  lengths: Uint32Array
  docFrequency: Uint32Array
  deadDocuments: Uint32Array
  totalTermFrequency: Float64Array
  revision: Uint32Array
  flags: Uint8Array
  count = 0
  liveCount = 0
  generation = 0
  tokenCodeUnits = 0
  private buckets = new Map<string, Bucket>()

  constructor(private readonly startCapacity: number) {
    this.sliceStart = new Uint32Array(startCapacity)
    this.sliceClass = new Uint8Array(startCapacity)
    this.lengths = new Uint32Array(startCapacity)
    this.docFrequency = new Uint32Array(startCapacity)
    this.deadDocuments = new Uint32Array(startCapacity)
    this.totalTermFrequency = new Float64Array(startCapacity)
    this.revision = new Uint32Array(startCapacity)
    this.flags = new Uint8Array(startCapacity)
  }

  get deadCount(): number {
    return this.count - this.liveCount
  }

  add(token: string): number {
    const ordinal = this.count
    if (ordinal === this.flags.length) this.growTo(ordinal * 2)
    this.count = ordinal + 1
    this.liveCount++
    this.tokenCodeUnits += token.length
    this.ids.set(token, ordinal)
    this.tokens.push(token)
    this.sliceClass[ordinal] = NO_SLICE
    this.flags[ordinal] = TERM_LIVE | TERM_ORDERED
    this.track(token, ordinal)
    return ordinal
  }

  kill(ordinal: number): void {
    const token = this.tokens[ordinal]
    this.ids.delete(token)
    const bucket = token.length > 0 ? this.buckets.get(token[0]) : undefined
    if (bucket !== undefined) bucket.dead++
    this.tokens[ordinal] = ''
    this.flags[ordinal] = 0
    this.lengths[ordinal] = 0
    this.docFrequency[ordinal] = 0
    this.deadDocuments[ordinal] = 0
    this.totalTermFrequency[ordinal] = 0
    this.sliceClass[ordinal] = NO_SLICE
    this.liveCount--
    this.tokenCodeUnits -= token.length
  }

  isLive(ordinal: number): boolean {
    return (this.flags[ordinal] & TERM_LIVE) !== 0
  }

  forEachLive(visit: (ordinal: number) => void): void {
    const flags = this.flags
    for (let ordinal = 0; ordinal < this.count; ordinal++) {
      if ((flags[ordinal] & TERM_LIVE) !== 0) visit(ordinal)
    }
  }

  forEachStartingWith(prefix: string, visit: (ordinal: number) => void): void {
    if (prefix.length === 0) {
      this.forEachLive(visit)
      return
    }
    const bucket = this.buckets.get(prefix[0])
    if (bucket === undefined) return
    this.compactBucket(prefix[0], bucket)
    const { ordinals, length } = bucket
    const flags = this.flags
    const tokens = this.tokens
    const checkPrefix = prefix.length > 1
    for (let i = 0; i < length; i++) {
      const ordinal = ordinals[i]
      if ((flags[ordinal] & TERM_LIVE) === 0) continue
      if (checkPrefix && !tokens[ordinal].startsWith(prefix)) continue
      visit(ordinal)
    }
  }

  renumber(): Int32Array {
    const remap = new Int32Array(this.count).fill(-1)
    const capacity = Math.max(this.startCapacity, this.liveCount)
    const next = new TermColumns(capacity)
    for (let ordinal = 0; ordinal < this.count; ordinal++) {
      if ((this.flags[ordinal] & TERM_LIVE) === 0) continue
      const target = next.add(this.tokens[ordinal])
      remap[ordinal] = target
      next.sliceStart[target] = this.sliceStart[ordinal]
      next.sliceClass[target] = this.sliceClass[ordinal]
      next.lengths[target] = this.lengths[ordinal]
      next.docFrequency[target] = this.docFrequency[ordinal]
      next.deadDocuments[target] = this.deadDocuments[ordinal]
      next.totalTermFrequency[target] = this.totalTermFrequency[ordinal]
      next.revision[target] = this.revision[ordinal]
      next.flags[target] = this.flags[ordinal]
    }
    this.ids = next.ids
    this.tokens = next.tokens
    this.sliceStart = next.sliceStart
    this.sliceClass = next.sliceClass
    this.lengths = next.lengths
    this.docFrequency = next.docFrequency
    this.deadDocuments = next.deadDocuments
    this.totalTermFrequency = next.totalTermFrequency
    this.revision = next.revision
    this.flags = next.flags
    this.buckets = next.buckets
    this.count = next.count
    this.liveCount = next.liveCount
    this.generation++
    return remap
  }

  clear(): void {
    this.ids = new Map()
    this.tokens = []
    this.buckets = new Map()
    this.count = 0
    this.liveCount = 0
    this.tokenCodeUnits = 0
    this.generation++
    this.sliceStart = new Uint32Array(this.startCapacity)
    this.sliceClass = new Uint8Array(this.startCapacity)
    this.lengths = new Uint32Array(this.startCapacity)
    this.docFrequency = new Uint32Array(this.startCapacity)
    this.deadDocuments = new Uint32Array(this.startCapacity)
    this.totalTermFrequency = new Float64Array(this.startCapacity)
    this.revision = new Uint32Array(this.startCapacity)
    this.flags = new Uint8Array(this.startCapacity)
  }

  byteLength(): number {
    let bucketBytes = 0
    for (const bucket of this.buckets.values()) bucketBytes += bucket.ordinals.byteLength
    return (
      this.sliceStart.byteLength +
      this.sliceClass.byteLength +
      this.lengths.byteLength +
      this.docFrequency.byteLength +
      this.deadDocuments.byteLength +
      this.totalTermFrequency.byteLength +
      this.revision.byteLength +
      this.flags.byteLength +
      bucketBytes
    )
  }

  private track(token: string, ordinal: number): void {
    if (token.length === 0) return
    const first = token[0]
    let bucket = this.buckets.get(first)
    if (bucket === undefined) {
      bucket = { ordinals: new Uint32Array(4), length: 0, dead: 0 }
      this.buckets.set(first, bucket)
    }
    if (bucket.length === bucket.ordinals.length) {
      bucket.ordinals = grow(bucket.ordinals, new Uint32Array(bucket.ordinals.length * 2))
    }
    bucket.ordinals[bucket.length++] = ordinal
  }

  private compactBucket(first: string, bucket: Bucket): void {
    if (bucket.dead * 2 <= bucket.length) return
    const { ordinals } = bucket
    let kept = 0
    for (let i = 0; i < bucket.length; i++) {
      const ordinal = ordinals[i]
      if ((this.flags[ordinal] & TERM_LIVE) !== 0) ordinals[kept++] = ordinal
    }
    bucket.length = kept
    bucket.dead = 0
    if (kept === 0) this.buckets.delete(first)
  }

  private growTo(capacity: number): void {
    this.sliceStart = grow(this.sliceStart, new Uint32Array(capacity))
    this.sliceClass = grow(this.sliceClass, new Uint8Array(capacity))
    this.lengths = grow(this.lengths, new Uint32Array(capacity))
    this.docFrequency = grow(this.docFrequency, new Uint32Array(capacity))
    this.deadDocuments = grow(this.deadDocuments, new Uint32Array(capacity))
    this.totalTermFrequency = grow(this.totalTermFrequency, new Float64Array(capacity))
    this.revision = grow(this.revision, new Uint32Array(capacity))
    this.flags = grow(this.flags, new Uint8Array(capacity))
  }
}
