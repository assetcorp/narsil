import type * as SegmentCodecCode from '../../core/segment-codec-leaf'
import type * as SegmentMergeCode from '../../core/segment-merge-leaf'
import type { OptionalCodeHost } from '../../engine/optional-code-host'
import type * as SuggestionStoreCode from '../../query-suggestions/store-leaf'
import type * as MsgpackCode from '../../serialization/msgpack-leaf'
import type * as VectorCoreCode from '../../vector/core-leaf'
import type * as DigestCode from '../durability/digest-leaf'
import { bindDigestNames } from './digest'
import { bindEngineNames } from './engine'
import { bindMsgpackNames } from './msgpack'
import { bindSegmentCodecNames } from './segment-codec'
import { bindSegmentMergeNames } from './segment-merge'
import { bindSuggestionStoreNames } from './suggestion-store'
import { bindVectorCoreNames } from './vector-core'

export * from './digest'
export * from './engine'
export * from './msgpack'
export * from './segment-codec'
export * from './segment-merge'
export * from './suggestion-store'
export * from './vector-core'

export function bindStorageHost(
  host: OptionalCodeHost,
  digest: typeof DigestCode,
  msgpack: typeof MsgpackCode,
  segmentCodec: typeof SegmentCodecCode,
  segmentMerge: typeof SegmentMergeCode,
  suggestionStore: typeof SuggestionStoreCode,
  vectorCore: typeof VectorCoreCode,
): void {
  bindEngineNames(host)
  bindDigestNames(digest)
  bindMsgpackNames(msgpack)
  bindSegmentCodecNames(segmentCodec)
  bindSegmentMergeNames(segmentMerge)
  bindSuggestionStoreNames(suggestionStore)
  bindVectorCoreNames(vectorCore)
}
