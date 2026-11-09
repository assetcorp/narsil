import type { OptionalCodeHost } from '../engine/optional-code-host'

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

export let BYTE_ORDER_MARK_WALK_BYTES_PER_HEADER: EngineNames['BYTE_ORDER_MARK_WALK_BYTES_PER_HEADER']
export let DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES: EngineNames['DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES']
export let DOCUMENT_REPLY_ENVELOPE_DEPTH: EngineNames['DOCUMENT_REPLY_ENVELOPE_DEPTH']
export let ErrorCodes: EngineNames['ErrorCodes']
export let getNestedValue: EngineNames['getNestedValue']
export let MAX_DOCUMENT_ENCODING_DEPTH: EngineNames['MAX_DOCUMENT_ENCODING_DEPTH']
export let NarsilError: EngineNames['NarsilError']
export type NarsilError = InstanceType<EngineNames['NarsilError']>

export function bindMsgpackHost(host: EngineNames): void {
  ;({
    BYTE_ORDER_MARK_WALK_BYTES_PER_HEADER,
    DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
    DOCUMENT_REPLY_ENVELOPE_DEPTH,
    ErrorCodes,
    getNestedValue,
    MAX_DOCUMENT_ENCODING_DEPTH,
    NarsilError,
  } = host)
}
