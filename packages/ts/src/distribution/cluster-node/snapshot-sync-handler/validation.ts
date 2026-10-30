import { MAX_SOURCE_ID_LENGTH } from '../constants'

/**
 * Control characters in a sourceId would collide with our per-source slot key
 * separator (NUL) and could let an authorized replica forge a key that aliases
 * another replica's slot. Beyond NUL, reject the full ASCII C0 + DEL set, the
 * Unicode C1 control range, the line and paragraph separators, and the BOM,
 * because all of these confuse log viewers, audit trails, and any future
 * normalization-aware comparator. Reject the whole class at the trust boundary
 * before any slot acquisition or engine work. Uses a character-code scan
 * rather than a regex to avoid embedding control characters in source
 * (biome's noControlCharactersInRegex).
 */
export function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20) {
      return true
    }
    if (code >= 0x7f && code <= 0x9f) {
      return true
    }
    if (code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      return true
    }
  }
  return false
}

export function validateSourceId(sourceId: unknown): string | null {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return 'request sourceId is missing'
  }
  if (sourceId.length > MAX_SOURCE_ID_LENGTH) {
    return `request sourceId exceeds ${MAX_SOURCE_ID_LENGTH} characters`
  }
  if (containsControlCharacter(sourceId)) {
    return 'request sourceId contains control characters'
  }
  return null
}
