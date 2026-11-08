import type { OptionalCodeHost } from '../engine/optional-code-host'

export { ErrorCodes, NarsilError } from '../errors'
export {
  DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
  DOCUMENT_REPLY_ENVELOPE_DEPTH,
  MAX_DOCUMENT_ENCODING_DEPTH,
} from './constants'

type EngineNames = Pick<
  OptionalCodeHost,
  | 'DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES'
  | 'DOCUMENT_REPLY_ENVELOPE_DEPTH'
  | 'ErrorCodes'
  | 'MAX_DOCUMENT_ENCODING_DEPTH'
  | 'NarsilError'
>

export function bindMsgpackHost(_host: EngineNames): void {}
