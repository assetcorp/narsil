import type { OptionalCodeHost } from '../../engine/optional-code-host'

export type FrozenKernelHost = Pick<
  OptionalCodeHost,
  | 'PENDING_DOCUMENTS'
  | 'PENDING_TOKEN_WORDS'
  | 'PENDING_TOKENS'
  | 'PENDING_UNITS'
  | 'SegmentRefusal'
  | 'checkText'
  | 'compareBytes'
  | 'packedTokens'
  | 'pendingSettled'
  | 'readFrozenParts'
  | 'requireRoom'
  | 'requireSegment'
  | 'resolveStopWords'
  | 'storedText'
  | 'textAt'
  | 'transformToken'
  | 'visitDocumentSurfaceSpellings'
>

export let PENDING_DOCUMENTS: FrozenKernelHost['PENDING_DOCUMENTS']
export let PENDING_TOKEN_WORDS: FrozenKernelHost['PENDING_TOKEN_WORDS']
export let PENDING_TOKENS: FrozenKernelHost['PENDING_TOKENS']
export let PENDING_UNITS: FrozenKernelHost['PENDING_UNITS']
export let SegmentRefusal: FrozenKernelHost['SegmentRefusal']
export let checkText: FrozenKernelHost['checkText']
export let compareBytes: FrozenKernelHost['compareBytes']
export let packedTokens: FrozenKernelHost['packedTokens']
export let pendingSettled: FrozenKernelHost['pendingSettled']
export let readFrozenParts: FrozenKernelHost['readFrozenParts']
export let requireRoom: FrozenKernelHost['requireRoom']
export let requireSegment: FrozenKernelHost['requireSegment']
export let resolveStopWords: FrozenKernelHost['resolveStopWords']
export let storedText: FrozenKernelHost['storedText']
export let textAt: FrozenKernelHost['textAt']
export let transformToken: FrozenKernelHost['transformToken']
export let visitDocumentSurfaceSpellings: FrozenKernelHost['visitDocumentSurfaceSpellings']

export function bindFrozenKernelHost(host: FrozenKernelHost): void {
  ;({
    PENDING_DOCUMENTS,
    PENDING_TOKEN_WORDS,
    PENDING_TOKENS,
    PENDING_UNITS,
    SegmentRefusal,
    checkText,
    compareBytes,
    packedTokens,
    pendingSettled,
    readFrozenParts,
    requireRoom,
    requireSegment,
    resolveStopWords,
    storedText,
    textAt,
    transformToken,
    visitDocumentSurfaceSpellings,
  } = host)
}
