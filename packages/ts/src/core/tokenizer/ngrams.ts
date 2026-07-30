const OTHER_SCRIPT = 0
const HAN_SCRIPT = 1
const HIRAGANA_SCRIPT = 2
const KATAKANA_SCRIPT = 3
const HANGUL_SCRIPT = 4

type ScriptKind =
  | typeof OTHER_SCRIPT
  | typeof HAN_SCRIPT
  | typeof HIRAGANA_SCRIPT
  | typeof KATAKANA_SCRIPT
  | typeof HANGUL_SCRIPT

const PROLONGED_SOUND_MARK = 0x30fc
const IDEOGRAPHIC_ITERATION_MARK = 0x3005
const LOWEST_CJK_CODE_POINT = 0x3005
const HIRAGANA_BLOCK_START = 0x3040
const HIRAGANA_BLOCK_END = 0x309f
const KATAKANA_BLOCK_START = 0x30a0
const KATAKANA_BLOCK_END = 0x30ff
const HAN_EXTENSION_A_START = 0x3400
const HAN_EXTENSION_A_END = 0x4dbf
const HAN_UNIFIED_START = 0x4e00
const HAN_UNIFIED_END = 0x9fff
const HAN_COMPATIBILITY_START = 0xf900
const HAN_COMPATIBILITY_END = 0xfaff
const SUPPLEMENTARY_PLANE_START = 0x10000

const HAN = /\p{Script=Han}/u
const HIRAGANA = /\p{Script=Hiragana}/u
const KATAKANA = /\p{Script=Katakana}/u
const HANGUL = /\p{Script=Hangul}/u

function classifyOutsideCommonBlocks(codePoint: number): ScriptKind {
  const char = String.fromCodePoint(codePoint)
  if (HAN.test(char)) return HAN_SCRIPT
  if (HIRAGANA.test(char)) return HIRAGANA_SCRIPT
  if (KATAKANA.test(char)) return KATAKANA_SCRIPT
  if (HANGUL.test(char)) return HANGUL_SCRIPT
  return OTHER_SCRIPT
}

function classify(codePoint: number, current: ScriptKind): ScriptKind {
  if (codePoint < LOWEST_CJK_CODE_POINT) return OTHER_SCRIPT
  if (codePoint === PROLONGED_SOUND_MARK) {
    return current === HIRAGANA_SCRIPT ? HIRAGANA_SCRIPT : KATAKANA_SCRIPT
  }
  if (codePoint >= HIRAGANA_BLOCK_START && codePoint <= HIRAGANA_BLOCK_END) return HIRAGANA_SCRIPT
  if (codePoint >= KATAKANA_BLOCK_START && codePoint <= KATAKANA_BLOCK_END) return KATAKANA_SCRIPT
  if (codePoint >= HAN_UNIFIED_START && codePoint <= HAN_UNIFIED_END) return HAN_SCRIPT
  if (codePoint >= HAN_EXTENSION_A_START && codePoint <= HAN_EXTENSION_A_END) return HAN_SCRIPT
  if (codePoint >= HAN_COMPATIBILITY_START && codePoint <= HAN_COMPATIBILITY_END) return HAN_SCRIPT
  if (codePoint === IDEOGRAPHIC_ITERATION_MARK) return HAN_SCRIPT
  return classifyOutsideCommonBlocks(codePoint)
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

    const next = classify(codePoint, kind)
    if (offsets.length > 0 && next !== kind) {
      offsets.push(index)
      emitRun(part, offsets, kind, size, out)
      offsets.length = 0
    }

    kind = next
    offsets.push(index)
    index += codePoint >= SUPPLEMENTARY_PLANE_START ? 2 : 1
  }

  offsets.push(length)
  emitRun(part, offsets, kind, size, out)
}
