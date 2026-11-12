import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

const [repositoryRoot, mode, file, ...rest] = process.argv.slice(2)
const require = createRequire(join(repositoryRoot, 'packages/ts/package.json'))
const { decode, encode } = require('@msgpack/msgpack')

const HEADER_BYTES = 32
const LENGTH_OFFSET = 8
const FLAGS_OFFSET = 12
const CHECKSUM_OFFSET = 14
const FLAG_COMPRESSED = 1
const FLAG_CHECKSUM = 1 << 3

function rewrite(path, change) {
  const bytes = readFileSync(path)
  const flags = bytes.readUInt16BE(FLAGS_OFFSET)
  if (flags & FLAG_COMPRESSED) throw new Error(`${path} is compressed`)
  const length = bytes.readUInt32BE(LENGTH_OFFSET)
  const value = decode(bytes.subarray(HEADER_BYTES, HEADER_BYTES + length))
  change(value)
  const payload = Buffer.from(encode(value))
  const header = Buffer.from(bytes.subarray(0, HEADER_BYTES))
  header.writeUInt32BE(payload.length, LENGTH_OFFSET)
  if (flags & FLAG_CHECKSUM) header.writeUInt32BE(crc32(payload), CHECKSUM_OFFSET)
  writeFileSync(path, Buffer.concat([header, payload]))
}

function renumberPartition(manifest, from, to) {
  for (const entry of [...manifest.partitions, ...manifest.checkpoint]) {
    if (entry.partitionId === from) entry.partitionId = to
  }
}

if (mode === 'renumber-partition') {
  const [from, to] = rest.map(Number)
  rewrite(file, manifest => renumberPartition(manifest, from, to))
} else if (mode === 'segment-counts') {
  const [docCount] = rest.map(Number)
  rewrite(file, manifest => {
    for (const partition of manifest.partitions) for (const segment of partition.segments) segment.docCount = docCount
  })
} else if (mode === 'max-partitions') {
  const [count] = rest.map(Number)
  rewrite(file, metadata => {
    metadata.partition_limits = { ...metadata.partition_limits, max_partitions: count }
  })
} else {
  throw new Error(`unknown mode ${mode}`)
}
