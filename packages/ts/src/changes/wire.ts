export const CHANGES_SUBPROTOCOL = 'narsil.changes.v1'
export const CHANGES_CLOSE_GOING_AWAY = 1001
export const CHANGES_CLOSE_POLICY = 1008
export const CHANGES_CLOSE_TOO_LARGE = 1009
export const CHANGES_CLOSE_SERVER_ERROR = 1011
export const CHANGES_CLOSE_CREDENTIAL_EXPIRED = 4401
export const CHANGES_CLOSE_SETTING = 4409
export const CHANGES_CLOSE_RESYNC = 4410
export const MAX_SUBSCRIBER_MESSAGE_BYTES = 65_536
const MAX_CLOSE_REASON_BYTES = 123

export function closeReasonOf(reason: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(reason).byteLength <= MAX_CLOSE_REASON_BYTES) return reason
  let kept = ''
  let bytes = 0
  for (const character of reason) {
    const width = encoder.encode(character).byteLength
    if (bytes + width > MAX_CLOSE_REASON_BYTES) break
    kept += character
    bytes += width
  }
  return kept
}
