export const QUOTE_CHARACTER = /["“”„]/

export function holdsQuoteCharacter(term: string): boolean {
  return QUOTE_CHARACTER.test(term)
}

export function holdsQuotedText(term: string): boolean {
  if (!QUOTE_CHARACTER.test(term)) return false
  const parts = term.split(QUOTE_CHARACTER)
  for (let index = 1; index < parts.length; index += 2) {
    if (parts[index].trim().length > 0) return true
  }
  return false
}
