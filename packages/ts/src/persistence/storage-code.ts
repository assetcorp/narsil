import { loadSegmentCodec } from '../core/segment-codec-code'
import { loadSegmentMerge } from '../core/segment-merge-code'
import { optionalCodeHost } from '../engine/optional-code-host'
import { codeLoader } from '../workers/code-loader'
import { loadVectorCore } from '../workers/vector-core-code'
import type * as StorageLeaf from './storage-leaf'

export type StorageCode = typeof StorageLeaf

const storageCode = codeLoader<StorageCode>(async () => {
  const [segmentCodec, segmentMerge, vectorCore, code] = await Promise.all([
    loadSegmentCodec(),
    loadSegmentMerge(),
    loadVectorCore(),
    import('./storage-leaf'),
  ])
  code.bindStorageHost(optionalCodeHost(), segmentCodec, segmentMerge, vectorCore)
  return code
}, 'storage')

export const loadStorageCode = storageCode.load
