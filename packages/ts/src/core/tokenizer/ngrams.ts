const OTHER_SCRIPT = 0
const HAN_SCRIPT = 1
const HIRAGANA_SCRIPT = 2
const KATAKANA_SCRIPT = 3
const HANGUL_SCRIPT = 4
const THAI_SCRIPT = 5
const LAO_SCRIPT = 6
const KHMER_SCRIPT = 7
const MYANMAR_SCRIPT = 8

type ScriptKind =
  | typeof OTHER_SCRIPT
  | typeof HAN_SCRIPT
  | typeof HIRAGANA_SCRIPT
  | typeof KATAKANA_SCRIPT
  | typeof HANGUL_SCRIPT
  | typeof THAI_SCRIPT
  | typeof LAO_SCRIPT
  | typeof KHMER_SCRIPT
  | typeof MYANMAR_SCRIPT

const PROLONGED_SOUND_MARK = 0x30fc
const IDEOGRAPHIC_ITERATION_MARK = 0x3005
const LOWEST_NGRAM_CODE_POINT = 0x0e00
const LOWEST_MARK_CODE_POINT = 0x0300
const THAI_BLOCK_END = 0x0e7f
const LAO_BLOCK_END = 0x0eff
const MYANMAR_BLOCK_START = 0x1000
const MYANMAR_BLOCK_END = 0x109f
const KHMER_BLOCK_START = 0x1780
const KHMER_BLOCK_END = 0x19ff
const SOUTHEAST_ASIAN_BLOCKS_END = 0x1a00
const HIRAGANA_BLOCK_START = 0x3040
const HIRAGANA_BLOCK_END = 0x309f
const COMBINING_VOICED_MARK = 0x3099
const COMBINING_SEMI_VOICED_MARK = 0x309a
const KATAKANA_BLOCK_START = 0x30a0
const KATAKANA_BLOCK_END = 0x30ff
const HAN_EXTENSION_A_START = 0x3400
const HAN_EXTENSION_A_END = 0x4dbf
const HAN_UNIFIED_START = 0x4e00
const HAN_UNIFIED_END = 0x9fff
const HANGUL_SYLLABLE_START = 0xac00
const HANGUL_SYLLABLE_END = 0xd7a3
const HAN_COMPATIBILITY_START = 0xf900
const HAN_COMPATIBILITY_END = 0xfaff
const SUPPLEMENTARY_PLANE_START = 0x10000

const MARK = /\p{M}/uy
const HAN = /\p{Script=Han}/uy
const HIRAGANA = /\p{Script=Hiragana}/uy
const KATAKANA = /\p{Script=Katakana}/uy
const HANGUL = /\p{Script=Hangul}/uy
const THAI = /\p{Script=Thai}/uy
const LAO = /\p{Script=Lao}/uy
const KHMER = /\p{Script=Khmer}/uy
const MYANMAR = /\p{Script=Myanmar}/uy

function matchesAt(pattern: RegExp, part: string, index: number): boolean {
  pattern.lastIndex = index
  return pattern.test(part)
}

function isMark(part: string, index: number, codePoint: number): boolean {
  if (codePoint < LOWEST_MARK_CODE_POINT) return false
  if (codePoint >= HAN_UNIFIED_START && codePoint <= HAN_UNIFIED_END) return false
  if (codePoint >= HIRAGANA_BLOCK_START && codePoint <= KATAKANA_BLOCK_END) {
    return codePoint === COMBINING_VOICED_MARK || codePoint === COMBINING_SEMI_VOICED_MARK
  }
  if (codePoint >= HANGUL_SYLLABLE_START && codePoint <= HANGUL_SYLLABLE_END) return false
  if (codePoint >= HAN_EXTENSION_A_START && codePoint <= HAN_EXTENSION_A_END) return false
  return matchesAt(MARK, part, index)
}

function classifyOutsideCommonBlocks(part: string, index: number): ScriptKind {
  if (matchesAt(HAN, part, index)) return HAN_SCRIPT
  if (matchesAt(HIRAGANA, part, index)) return HIRAGANA_SCRIPT
  if (matchesAt(KATAKANA, part, index)) return KATAKANA_SCRIPT
  if (matchesAt(HANGUL, part, index)) return HANGUL_SCRIPT
  if (matchesAt(THAI, part, index)) return THAI_SCRIPT
  if (matchesAt(LAO, part, index)) return LAO_SCRIPT
  if (matchesAt(KHMER, part, index)) return KHMER_SCRIPT
  if (matchesAt(MYANMAR, part, index)) return MYANMAR_SCRIPT
  return OTHER_SCRIPT
}

function classifySoutheastAsian(part: string, index: number, codePoint: number): ScriptKind {
  if (codePoint <= THAI_BLOCK_END) return matchesAt(THAI, part, index) ? THAI_SCRIPT : OTHER_SCRIPT
  if (codePoint <= LAO_BLOCK_END) return matchesAt(LAO, part, index) ? LAO_SCRIPT : OTHER_SCRIPT
  if (codePoint >= MYANMAR_BLOCK_START && codePoint <= MYANMAR_BLOCK_END) {
    return matchesAt(MYANMAR, part, index) ? MYANMAR_SCRIPT : OTHER_SCRIPT
  }
  if (codePoint >= KHMER_BLOCK_START && codePoint <= KHMER_BLOCK_END) {
    return matchesAt(KHMER, part, index) ? KHMER_SCRIPT : OTHER_SCRIPT
  }
  return classifyOutsideCommonBlocks(part, index)
}

function classify(part: string, index: number, codePoint: number, current: ScriptKind): ScriptKind {
  if (codePoint < LOWEST_NGRAM_CODE_POINT) return OTHER_SCRIPT
  if (codePoint < SOUTHEAST_ASIAN_BLOCKS_END) return classifySoutheastAsian(part, index, codePoint)
  if (codePoint === PROLONGED_SOUND_MARK) {
    return current === HIRAGANA_SCRIPT ? HIRAGANA_SCRIPT : KATAKANA_SCRIPT
  }
  if (codePoint >= HIRAGANA_BLOCK_START && codePoint <= HIRAGANA_BLOCK_END) return HIRAGANA_SCRIPT
  if (codePoint >= KATAKANA_BLOCK_START && codePoint <= KATAKANA_BLOCK_END) return KATAKANA_SCRIPT
  if (codePoint >= HAN_UNIFIED_START && codePoint <= HAN_UNIFIED_END) return HAN_SCRIPT
  if (codePoint >= HAN_EXTENSION_A_START && codePoint <= HAN_EXTENSION_A_END) return HAN_SCRIPT
  if (codePoint >= HANGUL_SYLLABLE_START && codePoint <= HANGUL_SYLLABLE_END) return HANGUL_SCRIPT
  if (codePoint >= HAN_COMPATIBILITY_START && codePoint <= HAN_COMPATIBILITY_END) return HAN_SCRIPT
  if (codePoint === IDEOGRAPHIC_ITERATION_MARK) return HAN_SCRIPT
  return classifyOutsideCommonBlocks(part, index)
}

function emitRun(part: string, offsets: number[], kind: ScriptKind, size: number, out: string[]): void {
  const count = offsets.length - 1
  if (count < 1) return
  if (kind === OTHER_SCRIPT || count <= size) {
    out.push(part.slice(offsets[0], offsets[count]))
    return
  }
  for (let start = 0; start + size <= count; start++) {
    out.push(part.slice(offsets[start], offsets[start + size]))
  }
}

export function expandNgrams(part: string, size: number, out: string[]): void {
  const length = part.length
  if (length === 0) return

  const offsets: number[] = []
  let kind: ScriptKind = OTHER_SCRIPT
  let index = 0

  while (index < length) {
    const codePoint = part.codePointAt(index)
    if (codePoint === undefined) break
    const width = codePoint >= SUPPLEMENTARY_PLANE_START ? 2 : 1

    if (offsets.length > 0 && isMark(part, index, codePoint)) {
      index += width
      continue
    }

    const next = classify(part, index, codePoint, kind)
    if (offsets.length > 0 && next !== kind) {
      offsets.push(index)
      emitRun(part, offsets, kind, size, out)
      offsets.length = 0
    }

    kind = next
    offsets.push(index)
    index += width
  }

  offsets.push(length)
  emitRun(part, offsets, kind, size, out)
}
