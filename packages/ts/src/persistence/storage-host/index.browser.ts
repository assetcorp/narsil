import type * as SegmentCodecCode from '../../core/segment-codec-leaf'
import type * as SegmentMergeCode from '../../core/segment-merge-leaf'
import type { OptionalCodeHost } from '../../engine/optional-code-host'
import type * as VectorCoreCode from '../../vector/core-leaf'
import { bindEngine1Names } from './engine-1'
import { bindEngine2Names } from './engine-2'
import { bindSegmentCodecNames } from './segment-codec'
import { bindSegmentMergeNames } from './segment-merge'
import { bindVectorCoreNames } from './vector-core'

export * from './engine-1'
export * from './engine-2'
export * from './segment-codec'
export * from './segment-merge'
export * from './vector-core'

export function bindStorageHost(
  host: OptionalCodeHost,
  segmentCodec: typeof SegmentCodecCode,
  segmentMerge: typeof SegmentMergeCode,
  vectorCore: typeof VectorCoreCode,
): void {
  bindEngine1Names(host)
  bindEngine2Names(host)
  bindSegmentCodecNames(segmentCodec)
  bindSegmentMergeNames(segmentMerge)
  bindVectorCoreNames(vectorCore)
}
