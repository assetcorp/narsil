export function withNormalisedSpellings(words: Iterable<string>, normalize: (token: string) => string): Set<string> {
  const listed = [...words]
  const expanded = new Set(listed)
  for (const word of listed) expanded.add(normalize(word))
  return expanded
}
