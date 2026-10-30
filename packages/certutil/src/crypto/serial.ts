import forge from 'node-forge'

const SERIAL_NUMBER_BYTES = 16
const CLEAR_SIGN_BIT = 0x7f
const SET_NEXT_HIGHEST_BIT = 0x40

export function randomSerialNumber(): string {
  const bytes = forge.random.getBytesSync(SERIAL_NUMBER_BYTES)
  const firstByte = (bytes.charCodeAt(0) & CLEAR_SIGN_BIT) | SET_NEXT_HIGHEST_BIT
  return forge.util.bytesToHex(String.fromCharCode(firstByte) + bytes.slice(1))
}
