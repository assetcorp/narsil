import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import {
  decodedPayload,
  openEnvelope,
  readTar,
  resealed,
  rewriteFiles,
  writeTar,
} from '../../../ts/src/__tests__/e2e/portability/archive-oracle.ts'

const [mode, source, target, original, replacement] = process.argv.slice(2)
const encoder = new TextEncoder()
const originalBytes = encoder.encode(original)
const replacementBytes = encoder.encode(replacement)
if (originalBytes.length !== replacementBytes.length) {
  throw new Error('the replacement must hold as many bytes as the original, so that no offset moves')
}

function positionsOf(bytes, wanted) {
  const positions = []
  for (let start = 0; start + wanted.length <= bytes.length; start++) {
    let matches = true
    for (let at = 0; at < wanted.length && matches; at++) matches = bytes[start + at] === wanted[at]
    if (matches) positions.push(start)
  }
  return positions
}

function replaceInside(value) {
  if (value instanceof Uint8Array) {
    const positions = positionsOf(value, originalBytes)
    for (const position of positions) value.set(replacementBytes, position)
    return positions.length
  }
  if (Array.isArray(value)) return value.reduce((total, element) => total + replaceInside(element), 0)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce((total, element) => total + replaceInside(element), 0)
  }
  return 0
}

function requireOneCopy(replaced) {
  if (replaced !== 1) {
    throw new Error(`the stored files hold ${replaced} copies of the original bytes, while the test expects one`)
  }
}

async function tamperArchive(archivePath, tamperedPath) {
  let replaced = 0
  const entries = rewriteFiles(readTar(new Uint8Array(await readFile(archivePath))), (payload, name) => {
    if (!name.startsWith('segments/')) return false
    const found = replaceInside(payload)
    replaced += found
    return found > 0
  })
  requireOneCopy(replaced)
  await writeFile(tamperedPath, writeTar(entries))
}

async function tamperDirectory(directory, indexName) {
  const manifestPath = join(directory, indexName, 'manifest')
  const manifestBytes = new Uint8Array(await readFile(manifestPath))
  const rewritten = new Map()
  let replaced = 0
  for (const partition of decodedPayload(manifestBytes).partitions) {
    for (const ref of partition.segments) {
      const path = join(directory, ref.key)
      let found = 0
      const sealed = resealed(new Uint8Array(await readFile(path)), payload => {
        found = replaceInside(payload)
        return payload
      })
      if (found === 0) continue
      replaced += found
      await writeFile(path, sealed)
      rewritten.set(ref.key, { bytes: sealed.byteLength, checksum: crc32(openEnvelope(sealed).payload) })
    }
  }
  requireOneCopy(replaced)
  const manifest = resealed(manifestBytes, payload => {
    for (const partition of payload.partitions) {
      for (const ref of partition.segments) Object.assign(ref, rewritten.get(ref.key) ?? {})
    }
    return payload
  })
  await writeFile(manifestPath, manifest)
}

if (mode === 'archive') await tamperArchive(source, target)
else if (mode === 'directory') await tamperDirectory(source, target)
else throw new Error(`unknown mode ${mode}`)
