const BMP_END = 0x10000
const MAX_CODE_POINT = 0x10ffff
const ASCII_END = 0x80
const ASCII_WORD_BITS = 64

export interface KeepTable {
  splitsCodePoints: boolean
  asciiKeep: [bigint, bigint]
  ranges: number[]
}

interface SplitTest {
  whole: RegExp
  prefix: RegExp
}

function splitTest(pattern: RegExp): SplitTest {
  const flags = pattern.flags.replace('g', '')
  return { whole: new RegExp(`^(?:${pattern.source})$`, flags), prefix: new RegExp(`^(?:${pattern.source})`, flags) }
}

function singleCharacterSplits(test: SplitTest, text: string): boolean {
  if (test.whole.test(text)) return true
  if (test.prefix.test(text))
    throw new Error(`/${test.whole.source}/ consumes part of U+${text.codePointAt(0)?.toString(16)}`)
  return false
}

export function keepTable(pattern: RegExp): KeepTable {
  if (!pattern.source.startsWith('[^') || !pattern.source.endsWith(']+')) {
    throw new Error(`/${pattern.source}/ is no negated character class repeated, which the core splits on`)
  }
  const splitsCodePoints = pattern.unicode
  const test = splitTest(pattern)
  const end = splitsCodePoints ? MAX_CODE_POINT + 1 : BMP_END
  const ranges: number[] = []
  const asciiKeep: [bigint, bigint] = [0n, 0n]
  let first = -1
  for (let value = 0; value < end; value++) {
    const text = splitsCodePoints ? String.fromCodePoint(value) : String.fromCharCode(value)
    const kept = !singleCharacterSplits(test, text)
    if (kept && value < ASCII_END) {
      asciiKeep[Math.floor(value / ASCII_WORD_BITS)] |= 1n << BigInt(value % ASCII_WORD_BITS)
    }
    if (kept && first < 0) first = value
    if (!kept && first >= 0) {
      ranges.push(first, value - 1)
      first = -1
    }
  }
  if (first >= 0) ranges.push(first, end - 1)
  return { splitsCodePoints, asciiKeep, ranges }
}
