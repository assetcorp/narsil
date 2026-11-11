import { optionalCodeHost } from '../engine/optional-code-host'
import { loadMessagePack } from '../serialization/msgpack-code'
import { codeLoader } from '../workers/code-loader'
import { loadSegmentCodec } from './segment-codec-code'
import type * as SegmentMergeLeaf from './segment-merge-leaf'

export type SegmentMerge = typeof SegmentMergeLeaf

const segmentMerge = codeLoader<SegmentMerge>(async () => {
  const [msgpack, codec, code] = await Promise.all([
    loadMessagePack(),
    loadSegmentCodec(),
    import('./segment-merge-leaf'),
  ])
  code.bindSegmentMergeHost(optionalCodeHost(), msgpack, codec)
  return code
}, 'segment merge')

export const loadSegmentMerge = segmentMerge.load
