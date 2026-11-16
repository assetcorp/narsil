import type * as MsgpackCode from '../../serialization/msgpack-leaf'

type MsgpackNames = Pick<
  typeof MsgpackCode,
  | 'decode'
  | 'decodeBoundedMessage'
  | 'decodeMulti'
  | 'encode'
  | 'encodeDocument'
  | 'restoreVectorFields'
  | 'setNestedValue'
>

export let decode: MsgpackNames['decode']
export let decodeBoundedMessage: MsgpackNames['decodeBoundedMessage']
export let decodeMulti: MsgpackNames['decodeMulti']
export let encode: MsgpackNames['encode']
export let encodeDocument: MsgpackNames['encodeDocument']
export let restoreVectorFields: MsgpackNames['restoreVectorFields']
export let setNestedValue: MsgpackNames['setNestedValue']

export function bindMsgpackNames(msgpack: MsgpackNames): void {
  ;({ decode, decodeBoundedMessage, decodeMulti, encode, encodeDocument, restoreVectorFields, setNestedValue } =
    msgpack)
}
