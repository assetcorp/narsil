const DOTTED_CAPITAL_I = '\u0130'
const COMBINING_DOT_ABOVE = '\u0307'
const ARMENIAN_MARKS = /[\u055B-\u055F]/
const FOLDED_FORMS = /\u0307|[\u0130\u055B-\u055F\u2019\u02BC\u02BB\uFF07]/g

function foldForm(match: string): string {
  if (match === DOTTED_CAPITAL_I) return 'i'
  if (match === COMBINING_DOT_ABOVE || ARMENIAN_MARKS.test(match)) return ''
  return "'"
}

export function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false
  }
  return true
}

export function normalizeForSplitting(text: string): string {
  if (isAscii(text)) return text.toLowerCase()
  return text.normalize('NFC').replace(FOLDED_FORMS, foldForm).toLowerCase()
}

export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}
