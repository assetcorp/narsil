import type { Digest } from '../persistence/digest-code'
import { KEY_FINGERPRINT_BYTES, KEY_FINGERPRINT_LABEL, SCRAMBLED_ID_BYTES } from './constants'

const INNER_PAD = 0x36
const OUTER_PAD = 0x5c

export interface PersonScrambler {
  readonly fingerprint: Uint8Array
  scramble(person: string): Uint8Array
}

function padState(digest: Digest, key: Uint8Array, pad: number, words: Uint32Array): Uint32Array {
  const block = new Uint8Array(digest.SHA256_BLOCK_BYTES)
  for (let i = 0; i < digest.SHA256_BLOCK_BYTES; i++) block[i] = (key[i] ?? 0) ^ pad
  const state = Uint32Array.from(digest.SHA256_INITIAL_STATE)
  digest.compressSha256Block(state, new DataView(block.buffer), 0, words)
  return state
}

export function createPersonScrambler(key: Uint8Array, digest: Digest): PersonScrambler {
  const blockBytes = digest.SHA256_BLOCK_BYTES
  const words = new Uint32Array(64)
  const blockKey = key.byteLength > blockBytes ? digest.sha256(key) : key
  const innerState = padState(digest, blockKey, INNER_PAD, words)
  const outerState = padState(digest, blockKey, OUTER_PAD, words)
  const working = new Uint32Array(8)
  const encoder = new TextEncoder()

  function digestAfter(prefixState: Uint32Array, message: Uint8Array): Uint8Array {
    working.set(prefixState)
    const view = digest.paddedSha256Message(message, blockBytes)
    for (let block = 0; block < view.byteLength; block += blockBytes) {
      digest.compressSha256Block(working, view, block, words)
    }
    return digest.sha256Digest(working)
  }

  function hmac(message: Uint8Array): Uint8Array {
    return digestAfter(outerState, digestAfter(innerState, message))
  }

  return {
    fingerprint: hmac(encoder.encode(KEY_FINGERPRINT_LABEL)).slice(0, KEY_FINGERPRINT_BYTES),
    scramble: person => hmac(encoder.encode(person)).slice(0, SCRAMBLED_ID_BYTES),
  }
}
