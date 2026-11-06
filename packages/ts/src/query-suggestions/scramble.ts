import {
  compressSha256Block,
  paddedSha256Message,
  SHA256_BLOCK_BYTES,
  SHA256_INITIAL_STATE,
  sha256,
  sha256Digest,
} from '../persistence/durability/sha256'
import { KEY_FINGERPRINT_BYTES, KEY_FINGERPRINT_LABEL, SCRAMBLED_ID_BYTES } from './constants'

const INNER_PAD = 0x36
const OUTER_PAD = 0x5c

export interface PersonScrambler {
  readonly fingerprint: Uint8Array
  scramble(person: string): Uint8Array
}

function padState(key: Uint8Array, pad: number, words: Uint32Array): Uint32Array {
  const block = new Uint8Array(SHA256_BLOCK_BYTES)
  for (let i = 0; i < SHA256_BLOCK_BYTES; i++) block[i] = (key[i] ?? 0) ^ pad
  const state = Uint32Array.from(SHA256_INITIAL_STATE)
  compressSha256Block(state, new DataView(block.buffer), 0, words)
  return state
}

export function createPersonScrambler(key: Uint8Array): PersonScrambler {
  const words = new Uint32Array(64)
  const blockKey = key.byteLength > SHA256_BLOCK_BYTES ? sha256(key) : key
  const innerState = padState(blockKey, INNER_PAD, words)
  const outerState = padState(blockKey, OUTER_PAD, words)
  const working = new Uint32Array(8)
  const encoder = new TextEncoder()

  function digestAfter(prefixState: Uint32Array, message: Uint8Array): Uint8Array {
    working.set(prefixState)
    const view = paddedSha256Message(message, SHA256_BLOCK_BYTES)
    for (let block = 0; block < view.byteLength; block += SHA256_BLOCK_BYTES) {
      compressSha256Block(working, view, block, words)
    }
    return sha256Digest(working)
  }

  function hmac(message: Uint8Array): Uint8Array {
    return digestAfter(outerState, digestAfter(innerState, message))
  }

  return {
    fingerprint: hmac(encoder.encode(KEY_FINGERPRINT_LABEL)).slice(0, KEY_FINGERPRINT_BYTES),
    scramble: person => hmac(encoder.encode(person)).slice(0, SCRAMBLED_ID_BYTES),
  }
}
