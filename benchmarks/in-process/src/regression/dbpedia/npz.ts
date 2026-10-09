import { unzipSync } from 'fflate'

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]
const NPY_VERSION_OFFSET = 6
const NPY_V1_HEADER_START = 10
const NPY_V2_HEADER_START = 12
const NPY_HEADER_LENGTH_OFFSET = 8
const FLOAT32_DESCR = '<f4'
const UNICODE_DESCR = /^<U(\d+)$/
const UTF32_UNIT_BYTES = 4

export interface NpyArray {
  descr: string
  shape: number[]
  data: Uint8Array
}

function headerField(header: string, field: string, pattern: RegExp, source: string): string {
  const match = pattern.exec(header)
  if (match === null) throw new Error(`${source} holds a NumPy header without ${field}`)
  return match[1]
}

export function parseNpy(bytes: Uint8Array, source: string): NpyArray {
  if (bytes.length < NPY_V2_HEADER_START || NPY_MAGIC.some((byte, i) => bytes[i] !== byte)) {
    throw new Error(`${source} is not a NumPy array file`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const major = bytes[NPY_VERSION_OFFSET]
  const headerStart = major === 1 ? NPY_V1_HEADER_START : NPY_V2_HEADER_START
  if (major !== 1 && major !== 2 && major !== 3) throw new Error(`${source} uses NumPy format version ${major}`)
  const headerLength =
    major === 1 ? view.getUint16(NPY_HEADER_LENGTH_OFFSET, true) : view.getUint32(NPY_HEADER_LENGTH_OFFSET, true)
  const header = new TextDecoder('latin1').decode(bytes.subarray(headerStart, headerStart + headerLength))
  if (headerField(header, 'fortran_order', /'fortran_order':\s*(True|False)/, source) === 'True') {
    throw new Error(`${source} stores its array in Fortran order`)
  }
  const shapeText = headerField(header, 'shape', /'shape':\s*\(([^)]*)\)/, source)
  const shape = shapeText
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const value = Number(part)
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${source} holds an unusable shape ${shapeText}`)
      return value
    })
  return {
    descr: headerField(header, 'descr', /'descr':\s*'([^']+)'/, source),
    shape,
    data: bytes.subarray(headerStart + headerLength),
  }
}

export function readNpz(bytes: Uint8Array, source: string): Map<string, NpyArray> {
  const arrays = new Map<string, NpyArray>()
  for (const [name, entry] of Object.entries(unzipSync(bytes))) {
    if (!name.endsWith('.npy')) continue
    arrays.set(name.slice(0, -'.npy'.length), parseNpy(entry, `${source}:${name}`))
  }
  return arrays
}

export function requireArray(arrays: Map<string, NpyArray>, name: string, source: string): NpyArray {
  const array = arrays.get(name)
  if (array === undefined) throw new Error(`${source} holds no array named ${name}`)
  return array
}

export function float32Rows(array: NpyArray, source: string): { rows: number; columns: number; values: Float32Array } {
  if (array.descr !== FLOAT32_DESCR || array.shape.length !== 2) {
    throw new Error(`${source} holds ${array.descr} ${JSON.stringify(array.shape)} where 32-bit float rows belong`)
  }
  const [rows, columns] = array.shape
  const byteLength = rows * columns * Float32Array.BYTES_PER_ELEMENT
  if (array.data.byteLength < byteLength) throw new Error(`${source} ends before its ${rows} rows`)
  const copy = array.data.slice(0, byteLength)
  return { rows, columns, values: new Float32Array(copy.buffer, copy.byteOffset, rows * columns) }
}

export function unicodeStrings(array: NpyArray, source: string): string[] {
  const match = UNICODE_DESCR.exec(array.descr)
  if (match === null) throw new Error(`${source} holds ${array.descr} where fixed-width text belongs`)
  const width = Number(match[1])
  const count = array.shape.reduce((product, size) => product * size, 1)
  if (array.data.byteLength < count * width * UTF32_UNIT_BYTES)
    throw new Error(`${source} ends before its ${count} strings`)
  const view = new DataView(array.data.buffer, array.data.byteOffset, array.data.byteLength)
  const strings: string[] = []
  for (let item = 0; item < count; item++) {
    let text = ''
    for (let unit = 0; unit < width; unit++) {
      const codePoint = view.getUint32((item * width + unit) * UTF32_UNIT_BYTES, true)
      if (codePoint === 0) break
      text += String.fromCodePoint(codePoint)
    }
    strings.push(text)
  }
  return strings
}
