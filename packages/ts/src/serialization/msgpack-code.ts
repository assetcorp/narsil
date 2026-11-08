import { getNestedValue } from '../core/partition/utils'
import { ErrorCodes, NarsilError } from '../errors'
import {
  DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
  DOCUMENT_REPLY_ENVELOPE_DEPTH,
  MAX_DOCUMENT_ENCODING_DEPTH,
} from './constants'
import type * as MessagePackLeaf from './msgpack-leaf'

export type MessagePackCode = typeof MessagePackLeaf

let loaded: MessagePackCode | null = null
let loading: Promise<MessagePackCode> | null = null

export function loadMessagePack(): Promise<MessagePackCode> {
  if (loaded !== null) return Promise.resolve(loaded)
  loading ??= import('./msgpack-leaf').then(
    code => {
      code.bindMsgpackHost({
        DOCUMENT_ENCODER_RETAINED_BUFFER_BYTES,
        DOCUMENT_REPLY_ENVELOPE_DEPTH,
        ErrorCodes,
        getNestedValue,
        MAX_DOCUMENT_ENCODING_DEPTH,
        NarsilError,
      })
      loaded = code
      return code
    },
    (cause: unknown) => {
      loading = null
      throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The MessagePack code could not load', {
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    },
  )
  return loading
}

export function loadedMessagePack(): MessagePackCode | null {
  return loaded
}

export function requireLoadedMessagePack(): MessagePackCode {
  if (loaded === null) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The engine reached MessagePack code before it loaded that code')
  }
  return loaded
}
