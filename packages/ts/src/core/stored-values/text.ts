export function storedText(units: Uint16Array, start: number, length: number): string {
  const end = start + length
  let text = ''
  for (let at = start; at < end; at++) text += String.fromCharCode(units[at])
  return text
}
