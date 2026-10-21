import { END_MASK, START_MASK, WORD_EDGE_MASK } from '../automaton'
import type { ClassName, PatternNode, SetItem } from './ast'
import { MAX_NUMBER_RANGE_DIGITS, MAX_PATTERN_GROUP_DEPTH, MAX_PATTERN_REPEAT_COUNT } from './constants'
import { compareDigits, numberRange } from './number-range'
import { type Fail, quoted, TRAILING_ESCAPE, toCodePoints } from './reader'

const BACKSLASH = 0x5c
const DOT = 0x2e
const BAR = 0x7c
const STAR = 0x2a
const PLUS = 0x2b
const QUESTION = 0x3f
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const OPEN_PAREN = 0x28
const CLOSE_PAREN = 0x29
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const CARET = 0x5e
const DOLLAR = 0x24
const LESS = 0x3c
const GREATER = 0x3e
const HYPHEN = 0x2d
const COMMA = 0x2c
const ZERO = 0x30
const NINE = 0x39

const RESERVED: ReadonlySet<number> = new Set([
  BACKSLASH,
  DOT,
  BAR,
  STAR,
  PLUS,
  QUESTION,
  OPEN_BRACE,
  CLOSE_BRACE,
  OPEN_PAREN,
  CLOSE_PAREN,
  OPEN_BRACKET,
  CLOSE_BRACKET,
  CARET,
  DOLLAR,
  LESS,
  GREATER,
])
const NO_COUNT =
  'holds a "{" that doesn\'t open a count such as {2}, {2,}, or {2,5}. Write "\\{" to match the brace itself'
const RANGE_ENDS_IN_CLASS =
  'holds a set range whose high end is a class, while both ends of a set range must be code points'
const SET_NEVER_CLOSES = 'opens a set that it never closes'
const NEGATED_EMPTY_SET =
  'holds the set "[^]", which has no member, because a "^" after "[" always negates the set. Write "\\^" to match a caret, "." to match any code point, or "\\]" to match "]" inside a set'

const CLASS_ESCAPES: ReadonlyMap<number, ClassName> = new Map([
  [0x64, 'digit'],
  [0x77, 'word'],
  [0x73, 'space'],
])
const WORD_EDGE_ESCAPE = 0x62

function isAsciiPunctuation(codePoint: number): boolean {
  return (
    (codePoint >= 0x21 && codePoint <= 0x2f) ||
    (codePoint >= 0x3a && codePoint <= 0x40) ||
    (codePoint >= 0x5b && codePoint <= 0x60) ||
    (codePoint >= 0x7b && codePoint <= 0x7e)
  )
}

function isDigit(codePoint: number | undefined): boolean {
  return codePoint !== undefined && codePoint >= ZERO && codePoint <= NINE
}

function unknownEscape(codePoint: number): string {
  const shown = quoted(`\\${String.fromCodePoint(codePoint)}`)
  if (isDigit(codePoint)) return `holds the back-reference ${shown}, which the grammar leaves out`
  if (codePoint === 0x70 || codePoint === 0x50) {
    return `holds the Unicode property class ${shown}, which the grammar leaves out`
  }
  return `holds ${shown}. A "\\" can come only before an ASCII punctuation mark, "d", "w", "s", or "b"`
}

function reservedHere(codePoint: number): string {
  const shown = String.fromCodePoint(codePoint)
  if (codePoint === STAR || codePoint === PLUS || codePoint === QUESTION) {
    return `holds the repeat ${quoted(shown)} with nothing before it to repeat`
  }
  return `holds ${quoted(shown)}, which has a meaning of its own in the grammar. Write ${quoted(`\\${shown}`)} to match the code point itself`
}

class RegexReader {
  private at = 0
  private depth = 0

  constructor(
    private readonly codePoints: readonly number[],
    private readonly fail: Fail,
  ) {}

  parse(): PatternNode {
    const pattern = this.parsePattern()
    if (this.at < this.codePoints.length) this.fail('closes a group that it never opened', this.at)
    return pattern
  }

  private peek(offset = 0): number | undefined {
    return this.codePoints[this.at + offset]
  }

  private parsePattern(): PatternNode {
    const branches = [this.parseBranch()]
    while (this.peek() === BAR) {
      this.at++
      branches.push(this.parseBranch())
    }
    return branches.length === 1 ? branches[0] : { kind: 'choice', branches }
  }

  private parseBranch(): PatternNode {
    const items: PatternNode[] = []
    for (let next = this.peek(); next !== undefined && next !== BAR && next !== CLOSE_PAREN; next = this.peek()) {
      items.push(this.parsePiece())
    }
    return items.length === 1 ? items[0] : { kind: 'sequence', items }
  }

  private parsePiece(): PatternNode {
    const atom = this.parseAtom()
    const repeated = this.parseRepeat(atom)
    const next = this.peek()
    if (repeated !== atom && (next === STAR || next === PLUS || next === QUESTION || next === OPEN_BRACE)) {
      this.fail(
        `holds a second repeat ${quoted(String.fromCodePoint(next))} after one atom. The grammar allows one repeat for each atom, so it has no lazy or possessive repeats`,
        this.at,
      )
    }
    return repeated
  }

  private parseAtom(): PatternNode {
    const start = this.at
    const codePoint = this.codePoints[this.at++]
    if (codePoint === BACKSLASH) return this.parseEscape(start)
    if (codePoint === DOT) return { kind: 'any' }
    if (codePoint === CARET) return { kind: 'assert', mask: START_MASK }
    if (codePoint === DOLLAR) return { kind: 'assert', mask: END_MASK }
    if (codePoint === OPEN_BRACKET) return this.parseSet(start)
    if (codePoint === OPEN_PAREN) return this.parseGroup(start)
    if (codePoint === LESS) return this.parseNumberRange(start)
    if (RESERVED.has(codePoint)) this.fail(reservedHere(codePoint), start)
    return { kind: 'literal', codePoint }
  }

  private parseEscape(start: number): PatternNode {
    const escaped = this.codePoints[this.at++]
    if (escaped === undefined) this.fail(TRAILING_ESCAPE, start)
    const name = CLASS_ESCAPES.get(escaped)
    if (name !== undefined) return { kind: 'class', name }
    if (escaped === WORD_EDGE_ESCAPE) return { kind: 'assert', mask: WORD_EDGE_MASK }
    if (isAsciiPunctuation(escaped)) return { kind: 'literal', codePoint: escaped }
    this.fail(unknownEscape(escaped), start)
  }

  private parseGroup(start: number): PatternNode {
    if (this.peek() === QUESTION) {
      this.fail(
        'holds "(?", which opens a lookaround, an inline flag, or a non-capturing group. The grammar leaves out all three',
        start,
      )
    }
    this.depth++
    if (this.depth > MAX_PATTERN_GROUP_DEPTH) {
      this.fail(`nests its groups more than ${MAX_PATTERN_GROUP_DEPTH} deep`, start)
    }
    const body = this.parsePattern()
    if (this.peek() !== CLOSE_PAREN) this.fail('opens a group that it never closes', start)
    this.at++
    this.depth--
    return body
  }

  private parseRepeat(atom: PatternNode): PatternNode {
    const codePoint = this.peek()
    if (codePoint === STAR || codePoint === PLUS || codePoint === QUESTION) {
      this.at++
      const min = codePoint === PLUS ? 1 : 0
      return { kind: 'repeat', body: atom, min, max: codePoint === QUESTION ? 1 : null }
    }
    if (codePoint !== OPEN_BRACE) return atom
    const start = this.at++
    const min = this.readCount(start)
    let max: number | null = min
    if (this.peek() === COMMA) {
      this.at++
      max = isDigit(this.peek()) ? this.readCount(start) : null
    }
    if (this.peek() !== CLOSE_BRACE) {
      this.fail(NO_COUNT, start)
    }
    this.at++
    if (max !== null && min > max) {
      this.fail(`holds the count {${min},${max}}, whose lower count is above its upper count`, start)
    }
    return { kind: 'repeat', body: atom, min, max }
  }

  private readCount(start: number): number {
    if (!isDigit(this.peek())) {
      this.fail(NO_COUNT, start)
    }
    let count = 0
    for (let digit = this.peek(); digit !== undefined && isDigit(digit); digit = this.peek()) {
      count = Math.min(count * 10 + digit - ZERO, MAX_PATTERN_REPEAT_COUNT + 1)
      this.at++
    }
    if (count > MAX_PATTERN_REPEAT_COUNT) {
      this.fail(`holds a count above the limit of ${MAX_PATTERN_REPEAT_COUNT}`, start)
    }
    return count
  }

  private parseSet(start: number): PatternNode {
    const negated = this.peek() === CARET
    if (negated) this.at++
    const items: SetItem[] = []
    for (;;) {
      const codePoint = this.peek()
      if (codePoint === undefined) this.fail(SET_NEVER_CLOSES, start)
      if (codePoint === CLOSE_BRACKET) break
      items.push(this.parseSetItem())
    }
    this.at++
    if (items.length === 0) this.fail(negated ? NEGATED_EMPTY_SET : 'holds an empty set', start)
    return { kind: 'set', negated, items }
  }

  private parseSetItem(): SetItem {
    const start = this.at
    const low = this.parseSetMember(true)
    if (typeof low !== 'number') return low
    if (this.peek() !== HYPHEN || this.peek(1) === CLOSE_BRACKET) return { kind: 'member', codePoint: low }
    this.at++
    const high = this.parseSetMember(false)
    if (typeof high !== 'number') this.fail(RANGE_ENDS_IN_CLASS, start)
    if (low > high) {
      this.fail(
        `holds the set range ${quoted(`${String.fromCodePoint(low)}-${String.fromCodePoint(high)}`)}, whose low end is above its high end`,
        start,
      )
    }
    return { kind: 'range', low, high }
  }

  private parseSetMember(classAllowed: boolean): number | SetItem {
    const start = this.at
    const codePoint = this.codePoints[this.at++]
    if (codePoint === undefined) this.fail(SET_NEVER_CLOSES, start)
    if (codePoint === OPEN_BRACKET || codePoint === CLOSE_BRACKET || codePoint === HYPHEN) {
      const shown = String.fromCodePoint(codePoint)
      this.fail(
        `holds ${quoted(shown)} inside a set. Write ${quoted(`\\${shown}`)} to match that code point there`,
        start,
      )
    }
    if (codePoint !== BACKSLASH) return codePoint
    const escaped = this.codePoints[this.at++]
    if (escaped === undefined) this.fail(TRAILING_ESCAPE, start)
    const name = CLASS_ESCAPES.get(escaped)
    if (name !== undefined && classAllowed) return { kind: 'class', name }
    if (isAsciiPunctuation(escaped)) return escaped
    if (name !== undefined) this.fail(RANGE_ENDS_IN_CLASS, start)
    this.fail(unknownEscape(escaped), start)
  }

  private parseNumberRange(start: number): PatternNode {
    const low = this.readDigits()
    const hyphen = this.codePoints[this.at++]
    const high = hyphen === HYPHEN ? this.readDigits() : ''
    const closing = this.codePoints[this.at++]
    if (low === '' || high === '' || closing !== GREATER) {
      this.fail(
        `holds a "<" that doesn't open a number range such as <1-65535>. Each end of a number range holds from 1 to ${MAX_NUMBER_RANGE_DIGITS} digits. Write "\\<" to match the "<" itself`,
        start,
      )
    }
    if (compareDigits(low, high) > 0) {
      this.fail(`holds the number range ${quoted(`<${low}-${high}>`)}, whose low end is above its high end`, start)
    }
    const expansion = new RegexReader(toCodePoints(numberRange(low, high)), this.fail).parse()
    return { kind: 'numberRange', expansion }
  }

  private readDigits(): string {
    let digits = ''
    for (let digit = this.peek(); isDigit(digit) && digit !== undefined; digit = this.peek()) {
      if (digits.length === MAX_NUMBER_RANGE_DIGITS) return ''
      digits += String.fromCodePoint(digit)
      this.at++
    }
    return digits
  }
}

export function parseRegex(codePoints: readonly number[], fail: Fail): PatternNode {
  return new RegexReader(codePoints, fail).parse()
}
