import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import { SETTLE_ORDER_CHECKS_PER_BUFFER } from './constants'
import { compareTableToUnits, holdsLoneSurrogate } from './unit-order'

interface HeldOrder {
  readonly stride: number
  readonly offsets: Uint32Array
  readonly text: Uint8Array
  readonly counts: Uint32Array
  readonly tokens: Uint32Array | undefined
  readonly ascends: boolean
}

const heldOrders = new WeakMap<ArrayBufferLike, HeldOrder[]>()

function sameView(left: ArrayBufferView | undefined, right: ArrayBufferView | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.buffer === right.buffer && left.byteOffset === right.byteOffset && left.byteLength === right.byteLength
}

function compareEntries(text: Uint8Array, leftFrom: number, leftTo: number, rightFrom: number, rightTo: number) {
  const leftLength = leftTo - leftFrom
  const rightLength = rightTo - rightFrom
  const shared = leftLength < rightLength ? leftLength : rightLength
  for (let at = 0; at < shared; at++) {
    const order = text[leftFrom + at] - text[rightFrom + at]
    if (order !== 0) return order
  }
  return leftLength - rightLength
}

function checkAscends(table: NativeFrozenStrings, stride: number, tokens: Uint32Array | undefined): boolean {
  const { offsets, text, counts } = table
  const size = counts.length
  if (size === 0) return true
  if ((size - 1) * stride + 1 >= offsets.length) return false
  if (tokens !== undefined && tokens.length < size) return false
  for (let entry = 0; entry < size; entry++) {
    const from = offsets[entry * stride]
    const to = offsets[entry * stride + 1]
    if (from > to || to > text.length) return false
    if (entry === 0) continue
    const before = (entry - 1) * stride
    const order =
      compareEntries(text, offsets[before], offsets[before + 1], from, to) ||
      (tokens === undefined ? 0 : tokens[entry - 1] - tokens[entry])
    if (order >= 0) return false
  }
  return true
}

export function tableAscends(table: NativeFrozenStrings, stride: number, tokens: Uint32Array | undefined): boolean {
  const buffer = table.offsets.buffer
  const held = heldOrders.get(buffer)
  if (held !== undefined)
    for (const order of held)
      if (
        order.stride === stride &&
        sameView(order.offsets, table.offsets) &&
        sameView(order.text, table.text) &&
        sameView(order.counts, table.counts) &&
        sameView(order.tokens, tokens)
      )
        return order.ascends
  const ascends = checkAscends(table, stride, tokens)
  const orders = held ?? []
  if (orders.length >= SETTLE_ORDER_CHECKS_PER_BUFFER) orders.shift()
  orders.push({ stride, offsets: table.offsets, text: table.text, counts: table.counts, tokens, ascends })
  if (held === undefined) heldOrders.set(buffer, orders)
  return ascends
}

export function entryOrder(
  table: NativeFrozenStrings,
  stride: number,
  tokens: Uint32Array | undefined,
  entry: number,
  units: Uint16Array,
  start: number,
  length: number,
  token: number,
): number {
  return (
    compareTableToUnits(
      table.text,
      table.offsets[entry * stride],
      table.offsets[entry * stride + 1],
      units,
      start,
      length,
    ) || (tokens === undefined ? 0 : tokens[entry] - token)
  )
}

export function findUnits(
  table: NativeFrozenStrings,
  units: Uint16Array,
  start: number,
  length: number,
  stride: number,
  tokens?: Uint32Array,
  token = 0,
): number {
  if (holdsLoneSurrogate(units, start, length)) return -1
  let low = 0
  let high = table.counts.length
  while (low < high) {
    const middle = low + ((high - low) >>> 1)
    const from = table.offsets[middle * stride]
    const to = table.offsets[middle * stride + 1]
    if (from > to || to > table.text.length) break
    const order =
      compareTableToUnits(table.text, from, to, units, start, length) ||
      (tokens === undefined ? 0 : tokens[middle] - token)
    if (order === 0) return middle
    if (order < 0) low = middle + 1
    else high = middle
  }
  if (low === high) return -1
  for (let at = 0; at < table.counts.length; at++) {
    const from = table.offsets[at * stride]
    const to = table.offsets[at * stride + 1]
    if ((tokens === undefined || tokens[at] === token) && from <= to && to <= table.text.length)
      if (compareTableToUnits(table.text, from, to, units, start, length) === 0) return at
  }
  return -1
}
