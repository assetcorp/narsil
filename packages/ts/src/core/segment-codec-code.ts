import { optionalCodeHost } from '../engine/optional-code-host'
import { codeLoader } from '../workers/code-loader'
import type * as SegmentCodecLeaf from './segment-codec-leaf'

export type SegmentCodec = typeof SegmentCodecLeaf

const segmentCodec = codeLoader<SegmentCodec>(
  () =>
    import('./segment-codec-leaf').then(code => {
      code.bindSegmentCodecHost(optionalCodeHost())
      return code
    }),
  'segment codec',
)

export const loadSegmentCodec = segmentCodec.load
