import { ErrorCodes, NarsilError } from '../../../errors'
import { MAX_GLOBAL_DEPTH } from './layout'
import { MAX_BUCKET_COUNT } from './manifest'

export interface BucketDirectory {
  globalDepth: number
  slots: number[]
}

export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0
}

export function log2OfPowerOfTwo(value: number): number {
  let depth = 0
  let remaining = value
  while (remaining > 1) {
    remaining >>= 1
    depth += 1
  }
  return depth
}

export function identityDirectory(globalDepth: number): BucketDirectory {
  if (!Number.isInteger(globalDepth) || globalDepth < 0 || globalDepth > MAX_GLOBAL_DEPTH) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Global depth ${globalDepth} is out of the supported range (0 to ${MAX_GLOBAL_DEPTH})`,
      { globalDepth, maxGlobalDepth: MAX_GLOBAL_DEPTH },
    )
  }
  const size = 1 << globalDepth
  const slots: number[] = new Array(size)
  for (let i = 0; i < size; i += 1) {
    slots[i] = i
  }
  return { globalDepth, slots }
}

export function highestBucketId(directory: BucketDirectory): number {
  let highest = -1
  for (const bucketId of directory.slots) {
    if (bucketId > highest) {
      highest = bucketId
    }
  }
  return highest
}

export function distinctBucketIds(directory: BucketDirectory): Set<number> {
  return new Set(directory.slots)
}

export function doubleDirectory(directory: BucketDirectory): void {
  if (directory.globalDepth >= MAX_GLOBAL_DEPTH) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Cannot grow the bucket directory beyond global depth ${MAX_GLOBAL_DEPTH}`,
      { globalDepth: directory.globalDepth, maxGlobalDepth: MAX_GLOBAL_DEPTH },
    )
  }
  const previous = directory.slots
  const next: number[] = new Array(previous.length * 2)
  for (let i = 0; i < previous.length; i += 1) {
    next[i] = previous[i]
    next[i + previous.length] = previous[i]
  }
  directory.slots = next
  directory.globalDepth += 1
}

export interface BucketSplitResult {
  lowBucketId: number
  highBucketId: number
}

export function splitBucket(
  directory: BucketDirectory,
  localDepthByBucket: Map<number, number>,
  bucketId: number,
): BucketSplitResult {
  const currentLocalDepth = localDepthByBucket.get(bucketId)
  if (currentLocalDepth === undefined) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Cannot split bucket ${bucketId} with no recorded depth`,
      {
        bucketId,
      },
    )
  }

  if (currentLocalDepth >= directory.globalDepth) {
    doubleDirectory(directory)
  }

  const childLocalDepth = currentLocalDepth + 1
  const highBucketId = highestBucketId(directory) + 1
  if (highBucketId >= MAX_BUCKET_COUNT) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Cannot allocate a new bucket; the bucket count would exceed the maximum of ${MAX_BUCKET_COUNT}`,
      { bucketId, maximum: MAX_BUCKET_COUNT },
    )
  }

  const discriminantBit = 1 << currentLocalDepth
  for (let slot = 0; slot < directory.slots.length; slot += 1) {
    if (directory.slots[slot] !== bucketId) {
      continue
    }
    if ((slot & discriminantBit) !== 0) {
      directory.slots[slot] = highBucketId
    }
  }

  localDepthByBucket.set(bucketId, childLocalDepth)
  localDepthByBucket.set(highBucketId, childLocalDepth)

  return { lowBucketId: bucketId, highBucketId }
}
