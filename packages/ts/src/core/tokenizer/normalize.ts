const DOTTED_CAPITAL_I = '\u0130'
const COMBINING_DOT_ABOVE = '\u0307'
const ARMENIAN_MARKS = /[\u055B-\u055F]/
const FOLDED_FORMS = /\u0307|[\u0130\u055B-\u055F\u2019\u02BC\u02BB]/g

const WIDTH_FORMS = /[\uFF01-\uFF5E\uFF61-\uFF9F]/
const WIDTH_FORMS_GLOBAL = /[\uFF01-\uFF5E\uFF61-\uFF9F]/g
const FULLWIDTH_ASCII_END = 0xff5e
const FULLWIDTH_ASCII_OFFSET = 0xfee0
const HALFWIDTH_KANA_START = 0xff61
const HALFWIDTH_VOICED_MARK = 0xff9e
const HALFWIDTH_SEMI_VOICED_MARK = 0xff9f
const COMBINING_VOICED_MARK = '\u3099'
const COMBINING_SEMI_VOICED_MARK = '\u309A'
const HALFWIDTH_KANA_TARGETS =
  '。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン'

function foldForm(match: string): string {
  if (match === DOTTED_CAPITAL_I) return 'i'
  if (match === COMBINING_DOT_ABOVE || ARMENIAN_MARKS.test(match)) return ''
  return "'"
}

function foldWidth(match: string): string {
  const codePoint = match.charCodeAt(0)
  if (codePoint <= FULLWIDTH_ASCII_END) return String.fromCharCode(codePoint - FULLWIDTH_ASCII_OFFSET)
  if (codePoint === HALFWIDTH_VOICED_MARK) return COMBINING_VOICED_MARK
  if (codePoint === HALFWIDTH_SEMI_VOICED_MARK) return COMBINING_SEMI_VOICED_MARK
  return HALFWIDTH_KANA_TARGETS[codePoint - HALFWIDTH_KANA_START]
}

export function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false
  }
  return true
}

export function foldWidthForms(text: string): string {
  if (!WIDTH_FORMS.test(text)) return text
  return text.replace(WIDTH_FORMS_GLOBAL, foldWidth)
}

export function normalizeForSplitting(text: string): string {
  if (isAscii(text)) return text.toLowerCase()
  return foldWidthForms(text).normalize('NFC').replace(FOLDED_FORMS, foldForm).toLowerCase()
}

export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}
