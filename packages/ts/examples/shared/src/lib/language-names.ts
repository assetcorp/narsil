const NAME_BY_CODE: Record<string, string> = {
  en: 'english',
  fr: 'french',
  ee: 'ewe',
  zu: 'zulu',
  tw: 'twi',
  yo: 'yoruba',
  sw: 'swahili',
  ha: 'hausa',
  dag: 'dagbani',
  ig: 'igbo',
}

/** Turns the code the dataset pickers use into the name an index takes. */
export function languageName(code: string | undefined): string {
  if (code === undefined) return 'english'
  return NAME_BY_CODE[code] ?? 'english'
}
