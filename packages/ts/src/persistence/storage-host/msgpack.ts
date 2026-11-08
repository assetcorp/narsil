import type * as MsgpackCode from '../../serialization/msgpack-leaf'

type MsgpackNames = Pick<typeof MsgpackCode, 'decode' | 'decodeMulti' | 'encode' | 'encodeDocument'>

export let decode: MsgpackNames['decode']
export let decodeMulti: MsgpackNames['decodeMulti']
export let encode: MsgpackNames['encode']
export let encodeDocument: MsgpackNames['encodeDocument']

export function bindMsgpackNames(msgpack: MsgpackNames): void {
  ;({ decode, decodeMulti, encode, encodeDocument } = msgpack)
}
