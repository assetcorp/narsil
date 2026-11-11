import { loadSegmentCodec } from '../core/segment-codec-code'
import { codeLoader } from '../workers/code-loader'
import { optionalCodeHost } from './optional-code-host'
import type * as OptionalWrites from './optional-writes'

export type OptionalWritesCode = typeof OptionalWrites

const optionalWrites = codeLoader<OptionalWritesCode>(async () => {
  const [segmentCodec, code] = await Promise.all([loadSegmentCodec(), import('./optional-writes')])
  code.bindOptionalWritesHost(optionalCodeHost(), segmentCodec)
  return code
}, 'write')

export const loadOptionalWrites = optionalWrites.load
