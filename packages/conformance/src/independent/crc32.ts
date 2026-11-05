const IEEE_REFLECTED_POLYNOMIAL = 0xedb88320
const TABLE_ENTRIES = 256
const BITS_PER_BYTE = 8

function buildTable(): Uint32Array {
  const table = new Uint32Array(TABLE_ENTRIES)
  for (let entry = 0; entry < TABLE_ENTRIES; entry++) {
    let crc = entry
    for (let bit = 0; bit < BITS_PER_BYTE; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ IEEE_REFLECTED_POLYNOMIAL : crc >>> 1
    }
    table[entry] = crc >>> 0
  }
  return table
}

const TABLE = buildTable()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let at = 0; at < data.length; at++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ data[at]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}
