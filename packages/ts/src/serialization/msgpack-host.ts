import type { OptionalCodeHost } from '../engine/optional-code-host'

export { getNestedValue } from '../core/partition/utils'
export { ErrorCodes, NarsilError } from '../errors'
export {
  BYTE_ORDER_MARK_WALK_BYTES_PER_HEADER,
  DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
  DOCUMENT_REPLY_ENVELOPE_DEPTH,
  MAX_DOCUMENT_ENCODING_DEPTH,
} from './constants'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'BYTE_ORDER_MARK_WALK_BYTES_PER_HEADER'
  | 'DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES'
  | 'DOCUMENT_REPLY_ENVELOPE_DEPTH'
  | 'ErrorCodes'
  | 'getNestedValue'
  | 'MAX_DOCUMENT_ENCODING_DEPTH'
  | 'NarsilError'
>

export function bindMsgpackHost(_host: EngineNames): void {}
