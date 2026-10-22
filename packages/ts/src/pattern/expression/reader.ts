export type Fail = (reason: string, at: number) => never

export const TRAILING_ESCAPE = 'ends in a "\\" with no code point after it'

export function toCodePoints(text: string): number[] {
  const codePoints: number[] = []
  for (let at = 0; at < text.length; at++) {
    const codePoint = text.codePointAt(at) ?? 0
    if (codePoint > 0xffff) at++
    codePoints.push(codePoint)
  }
  return codePoints
}

export function quoted(text: string): string {
  return `"${text}"`
}
