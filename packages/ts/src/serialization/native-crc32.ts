import * as zlib from 'node:zlib'

export type NativeCrc32 = (data: Uint8Array, previous: number) => number

const candidate: unknown = (zlib as { crc32?: unknown }).crc32

export const nativeCrc32: NativeCrc32 | null = typeof candidate === 'function' ? (candidate as NativeCrc32) : null
