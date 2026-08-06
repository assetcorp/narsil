export function encodeCursorText(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf-8').toString('base64')
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeCursorText(encoded: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(encoded, 'base64').toString('utf-8')
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
