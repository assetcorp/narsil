import type { NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { storedText } from '../stored-values/text'
import { embedded, type FieldMergePlan, uint32, words } from './regions'

interface Key {
  text: string
  run: readonly number[] | null
  ordinals: Set<number>
}

function compareKeys(left: Key, right: Key): number {
  if (left.run !== null && right.run !== null) {
    for (let at = 0; at < 3; at++) {
      if (left.run[at] !== right.run[at]) return left.run[at] - right.run[at]
    }
    return 0
  }
  return left.text < right.text ? -1 : left.text > right.text ? 1 : 0
}

function compareSuffix(left: string, right: string): number {
  for (let at = 1; at <= Math.min(left.length, right.length); at++) {
    const difference = left.charCodeAt(left.length - at) - right.charCodeAt(right.length - at)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

export function dictionaryPlan(sources: readonly NativeFieldMergeSource[], pattern: boolean): FieldMergePlan {
  const keys = new Map<string, Key>()
  const present = new Set<number>()
  let inputKeyCount = 0
  let inputRowCount = 0
  for (const source of sources) {
    const offsets = words(source, 2)
    const postings = words(source, 3)
    const textOffsets = words(source, 1)
    const count = pattern ? textOffsets.length / 3 : textOffsets.length - 1
    inputKeyCount += count
    embedded(inputKeyCount <= 0xffffffff && offsets[0] === 0 && offsets[count] === postings.length)
    if (pattern) {
      for (const point of textOffsets) embedded(point <= 0x10ffff)
      for (const ordinal of words(source, 0)) {
        embedded(ordinal < source.mapping.length)
        if (source.mapping[ordinal] !== 0xffffffff) present.add(source.mapping[ordinal])
      }
    } else {
      embedded(textOffsets[0] === 0 && textOffsets[count] === source.regions[0].length)
    }
    for (let at = 0; at < count; at++) {
      embedded(offsets[at] <= offsets[at + 1] && offsets[at + 1] <= postings.length)
      let text: string
      let run: readonly number[] | null = null
      if (pattern) {
        run = [textOffsets[at * 3], textOffsets[at * 3 + 1], textOffsets[at * 3 + 2]]
        text = `${run[0]},${run[1]},${run[2]}`
      } else {
        embedded(
          textOffsets[at] <= textOffsets[at + 1] &&
            textOffsets[at + 1] <= source.regions[0].length &&
            words(source, 4)[at] < count,
        )
        text = storedText(source.regions[0] as Uint16Array, textOffsets[at], textOffsets[at + 1] - textOffsets[at])
      }
      let key = keys.get(text)
      if (key === undefined) {
        key = { text, run, ordinals: new Set() }
        keys.set(text, key)
      }
      for (let row = offsets[at]; row < offsets[at + 1]; row++) {
        const ordinal = postings[row]
        embedded(ordinal < source.mapping.length)
        const target = source.mapping[ordinal]
        if (target === 0xffffffff) continue
        uint32(++inputRowCount)
        key.ordinals.add(target)
      }
    }
  }
  const ordered = [...keys.values()].filter(key => !pattern || key.ordinals.size > 0).sort(compareKeys)
  uint32(ordered.length + 1)
  const rows = ordered.map(key => [...key.ordinals].sort((left, right) => left - right))
  const suffixes = ordered
    .map((_, at) => at)
    .sort((left, right) => compareSuffix(ordered[left].text, ordered[right].text))
  const ordinals = [...present].sort((left, right) => left - right)
  let textLength = 0
  let rowCount = 0
  for (let at = 0; at < ordered.length; at++) {
    textLength += pattern ? 3 : ordered[at].text.length
    rowCount += rows[at].length
    uint32(textLength)
    uint32(rowCount)
  }
  const lengths = new Uint32Array(8)
  lengths[0] = pattern ? ordinals.length : textLength
  lengths[1] = pattern ? textLength : ordered.length + 1
  lengths[2] = ordered.length + 1
  lengths[3] = rowCount
  if (!pattern) lengths[4] = ordered.length
  return {
    lengths,
    publish(output): void {
      const offsets = output[2] as Uint32Array
      const postings = output[3] as Uint32Array
      const textOffsets = output[1] as Uint32Array
      const text = output[0] as Uint16Array
      let row = 0
      let unit = 0
      offsets[0] = 0
      if (!pattern) textOffsets[0] = 0
      for (let at = 0; at < ordered.length; at++) {
        const key = ordered[at]
        if (key.run !== null) {
          for (let point = 0; point < 3; point++) textOffsets[at * 3 + point] = key.run[point]
        } else {
          for (let index = 0; index < key.text.length; index++) text[unit++] = key.text.charCodeAt(index)
          textOffsets[at + 1] = unit
          ;(output[4] as Uint32Array)[at] = suffixes[at]
        }
        for (const ordinal of rows[at]) postings[row++] = ordinal
        offsets[at + 1] = row
      }
      if (pattern) {
        const present = output[0] as Uint32Array
        for (let at = 0; at < ordinals.length; at++) present[at] = ordinals[at]
      }
    },
  }
}
