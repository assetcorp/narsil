function adjustUtf16Unit(unit: number): number {
  if (unit < 0xd800) return unit
  if (unit < 0xe000) return unit + 0x2000
  return unit - 0x800
}

/**
 * Compares two strings in Unicode code point order, the identity order the
 * specification assigns to document IDs, facet values, terms, and merges.
 *
 * The first differing position decides, a prefix orders before its extension,
 * and a supplementary character orders above every basic-plane character, which
 * a plain UTF-16 comparison gets wrong.
 *
 * @param a - The first string.
 * @param b - The second string.
 * @returns A negative number when `a` orders first, a positive number when `b` does, and 0 when they are equal.
 */
export function compareCodePoints(a: string, b: string): number {
  const shorter = a.length < b.length ? a.length : b.length
  let i = 0
  while (i < shorter && a.charCodeAt(i) === b.charCodeAt(i)) i++
  if (i === shorter) return a.length - b.length
  return adjustUtf16Unit(a.charCodeAt(i)) - adjustUtf16Unit(b.charCodeAt(i))
}
