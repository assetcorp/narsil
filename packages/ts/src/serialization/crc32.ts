const IEEE_POLYNOMIAL = 0xedb88320

let cachedTable: Uint32Array | null = null

function buildTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ IEEE_POLYNOMIAL : crc >>> 1
    }
    table[i] = crc
  }
  return table
}

function getTable(): Uint32Array {
  if (cachedTable === null) {
    cachedTable = buildTable()
  }
  return cachedTable
}

export function crc32(data: Uint8Array): number {
  const table = getTable()
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}
