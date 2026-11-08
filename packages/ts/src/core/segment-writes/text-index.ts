import { TEXT_INDEX_START_SLOTS } from './constants'

const LENGTH_MIX = 0x9e3779b1
const FINAL_MIX = 0x85ebca6b
const LAST_STAMP = 0xffffffff
const ABSENT = -1

function textSlot(text: string, mask: number): number {
  const length = text.length
  if (length === 0) return 0
  const mixed =
    Math.imul(length, LENGTH_MIX) ^
    text.charCodeAt(0) ^
    (text.charCodeAt(length - 1) << 8) ^
    (text.charCodeAt(length >>> 1) << 16)
  return (Math.imul(mixed, FINAL_MIX) >>> 0) & mask
}

export class TextIndex {
  private slots = new Uint32Array(TEXT_INDEX_START_SLOTS)
  private stamps = new Uint32Array(TEXT_INDEX_START_SLOTS)
  private stamp = 1
  private used = 0
  private vacant = 0
  owner: object | null = null

  clear(owner: object | null = null): void {
    this.owner = owner
    this.used = 0
    if (this.stamp === LAST_STAMP) {
      this.stamps.fill(0)
      this.stamp = 0
    }
    this.stamp++
  }

  find(texts: readonly string[], text: string): number {
    const mask = this.slots.length - 1
    let slot = textSlot(text, mask)
    while (this.stamps[slot] === this.stamp) {
      const index = this.slots[slot]
      if (texts[index] === text) return index
      slot = (slot + 1) & mask
    }
    this.vacant = slot
    return ABSENT
  }

  insert(texts: readonly string[], index: number): void {
    if ((this.used + 1) * 2 > this.slots.length) this.grow(texts)
    this.place(texts[index], index)
    this.used++
  }

  insertMissed(texts: readonly string[], index: number): void {
    if ((this.used + 1) * 2 > this.slots.length) {
      this.insert(texts, index)
      return
    }
    this.stamps[this.vacant] = this.stamp
    this.slots[this.vacant] = index
    this.used++
  }

  private place(text: string, index: number): void {
    const mask = this.slots.length - 1
    let slot = textSlot(text, mask)
    while (this.stamps[slot] === this.stamp) slot = (slot + 1) & mask
    this.stamps[slot] = this.stamp
    this.slots[slot] = index
  }

  private grow(texts: readonly string[]): void {
    const capacity = this.slots.length * 2
    this.slots = new Uint32Array(capacity)
    this.stamps = new Uint32Array(capacity)
    this.stamp = 1
    for (let index = 0; index < this.used; index++) this.place(texts[index], index)
  }
}
