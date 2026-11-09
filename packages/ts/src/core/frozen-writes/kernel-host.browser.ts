import type { OptionalCodeHost } from '../../engine/optional-code-host'

export type FrozenKernelHost = Pick<
  OptionalCodeHost,
  | 'PENDING_DOCUMENTS'
  | 'PENDING_TOKEN_WORDS'
  | 'PENDING_TOKENS'
  | 'PENDING_UNITS'
  | 'SegmentRefusal'
  | 'compareBytes'
  | 'findEntry'
  | 'pendingSettled'
  | 'readFrozenRequest'
  | 'readFrozenSettle'
  | 'requireRoom'
  | 'requireSegment'
  | 'storedText'
  | 'textAt'
>

export let PENDING_DOCUMENTS: FrozenKernelHost['PENDING_DOCUMENTS']
export let PENDING_TOKEN_WORDS: FrozenKernelHost['PENDING_TOKEN_WORDS']
export let PENDING_TOKENS: FrozenKernelHost['PENDING_TOKENS']
export let PENDING_UNITS: FrozenKernelHost['PENDING_UNITS']
export let SegmentRefusal: FrozenKernelHost['SegmentRefusal']
export let compareBytes: FrozenKernelHost['compareBytes']
export let findEntry: FrozenKernelHost['findEntry']
export let pendingSettled: FrozenKernelHost['pendingSettled']
export let readFrozenRequest: FrozenKernelHost['readFrozenRequest']
export let readFrozenSettle: FrozenKernelHost['readFrozenSettle']
export let requireRoom: FrozenKernelHost['requireRoom']
export let requireSegment: FrozenKernelHost['requireSegment']
export let storedText: FrozenKernelHost['storedText']
export let textAt: FrozenKernelHost['textAt']

export function bindFrozenKernelHost(host: FrozenKernelHost): void {
  ;({
    PENDING_DOCUMENTS,
    PENDING_TOKEN_WORDS,
    PENDING_TOKENS,
    PENDING_UNITS,
    SegmentRefusal,
    compareBytes,
    findEntry,
    pendingSettled,
    readFrozenRequest,
    readFrozenSettle,
    requireRoom,
    requireSegment,
    storedText,
    textAt,
  } = host)
}
