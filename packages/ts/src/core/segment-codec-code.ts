import { optionalCodeHost } from '../engine/optional-code-host'
import { loadMessagePack } from '../serialization/msgpack-code'
import { codeLoader } from '../workers/code-loader'
import type * as SegmentCodecLeaf from './segment-codec-leaf'

export type SegmentCodec = typeof SegmentCodecLeaf

const segmentCodec = codeLoader<SegmentCodec>(async () => {
  const [msgpack, code] = await Promise.all([loadMessagePack(), import('./segment-codec-leaf')])
  code.bindSegmentCodecHost(optionalCodeHost(), msgpack)
  return code
}, 'segment codec')

export const loadSegmentCodec = segmentCodec.load
