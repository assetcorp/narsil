function isAscii(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    if (token.charCodeAt(i) > 127) return false
  }
  return true
}

export function removeMarks(token: string, marks: RegExp): string {
  if (isAscii(token)) return token
  const decomposed = token.normalize('NFD')
  const stripped = decomposed.replace(marks, '')
  return stripped === decomposed ? token : stripped.normalize('NFC')
}
