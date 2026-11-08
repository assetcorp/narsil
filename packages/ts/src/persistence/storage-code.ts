import { loadSegmentCodec } from '../core/segment-codec-code'
import { loadSegmentMerge } from '../core/segment-merge-code'
import { optionalCodeHost } from '../engine/optional-code-host'
import { loadSuggestionStore } from '../query-suggestions/store-code'
import { codeLoader } from '../workers/code-loader'
import { loadVectorCore } from '../workers/vector-core-code'
import { loadDigest } from './digest-code'
import type * as StorageLeaf from './storage-leaf'

export type StorageCode = typeof StorageLeaf

const storageCode = codeLoader<StorageCode>(async () => {
  const [digest, segmentCodec, segmentMerge, suggestionStore, vectorCore, code] = await Promise.all([
    loadDigest(),
    loadSegmentCodec(),
    loadSegmentMerge(),
    loadSuggestionStore(),
    loadVectorCore(),
    import('./storage-leaf'),
  ])
  code.bindStorageHost(optionalCodeHost(), digest, segmentCodec, segmentMerge, suggestionStore, vectorCore)
  return code
}, 'storage')

export const loadStorageCode = storageCode.load
