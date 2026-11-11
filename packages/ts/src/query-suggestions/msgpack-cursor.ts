export class MalformedPayload extends Error {}

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function headerBytes(length: number, fixLimit: number): number {
  if (length <= fixLimit) return 1
  if (length <= 0xff) return 2
  if (length <= 0xffff) return 3
  return 5
}

export function stringSize(text: string): number {
  const length = utf8ByteLength(text)
  return headerBytes(length, 31) + length
}

export function binarySize(length: number): number {
  return (length <= 0xff ? 2 : length <= 0xffff ? 3 : 5) + length
}

export function containerHeaderSize(length: number): number {
  if (length <= 15) return 1
  return length <= 0xffff ? 3 : 5
}

export function uintSize(value: number): number {
  if (value < 0x80) return 1
  if (value <= 0xff) return 2
  if (value <= 0xffff) return 3
  if (value <= 0xffffffff) return 5
  return 9
}

export class ExactWriter {
  readonly bytes: Uint8Array
  private readonly view: DataView
  private position: number
  private readonly encoder = new TextEncoder()

  constructor(bytes: Uint8Array, start: number) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.position = start
  }

  get offset(): number {
    return this.position
  }

  skip(length: number): void {
    this.position += length
  }

  map(length: number): void {
    this.container(length, 0x80, 0xde, 0xdf)
  }

  array(length: number): void {
    this.container(length, 0x90, 0xdc, 0xdd)
  }

  string(text: string): void {
    const length = utf8ByteLength(text)
    if (length <= 31) this.bytes[this.position++] = 0xa0 | length
    else if (length <= 0xff) {
      this.bytes[this.position++] = 0xd9
      this.bytes[this.position++] = length
    } else if (length <= 0xffff) {
      this.bytes[this.position++] = 0xda
      this.view.setUint16(this.position, length)
      this.position += 2
    } else {
      this.bytes[this.position++] = 0xdb
      this.view.setUint32(this.position, length)
      this.position += 4
    }
    const written = this.encoder.encodeInto(text, this.bytes.subarray(this.position, this.position + length)).written
    if (written !== length) throw new MalformedPayload('A string took a different number of bytes than measured')
    this.position += length
  }

  binary(source: Uint8Array, offset: number, length: number): void {
    if (length <= 0xff) {
      this.bytes[this.position++] = 0xc4
      this.bytes[this.position++] = length
    } else if (length <= 0xffff) {
      this.bytes[this.position++] = 0xc5
      this.view.setUint16(this.position, length)
      this.position += 2
    } else {
      this.bytes[this.position++] = 0xc6
      this.view.setUint32(this.position, length)
      this.position += 4
    }
    this.bytes.set(source.subarray(offset, offset + length), this.position)
    this.position += length
  }

  uint(value: number): void {
    if (value < 0x80) this.bytes[this.position++] = value
    else if (value <= 0xff) {
      this.bytes[this.position++] = 0xcc
      this.bytes[this.position++] = value
    } else if (value <= 0xffff) {
      this.bytes[this.position++] = 0xcd
      this.view.setUint16(this.position, value)
      this.position += 2
    } else if (value <= 0xffffffff) {
      this.bytes[this.position++] = 0xce
      this.view.setUint32(this.position, value)
      this.position += 4
    } else {
      this.bytes[this.position++] = 0xcf
      this.view.setBigUint64(this.position, BigInt(value))
      this.position += 8
    }
  }

  private container(length: number, fix: number, sixteen: number, thirtyTwo: number): void {
    if (length <= 15) this.bytes[this.position++] = fix | length
    else if (length <= 0xffff) {
      this.bytes[this.position++] = sixteen
      this.view.setUint16(this.position, length)
      this.position += 2
    } else {
      this.bytes[this.position++] = thirtyTwo
      this.view.setUint32(this.position, length)
      this.position += 4
    }
  }
}

export class StrictReader {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private position: number
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

  constructor(bytes: Uint8Array, start: number) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.position = start
  }

  get offset(): number {
    return this.position
  }

  get atEnd(): boolean {
    return this.position === this.bytes.byteLength
  }

  map(): number {
    return this.container(0x80, 0xde, 0xdf, 'a map')
  }

  array(): number {
    return this.container(0x90, 0xdc, 0xdd, 'an array')
  }

  string(): string {
    const tag = this.byte()
    let length: number
    if ((tag & 0xe0) === 0xa0) length = tag & 0x1f
    else if (tag === 0xd9) length = this.byte()
    else if (tag === 0xda) length = this.uint16()
    else if (tag === 0xdb) length = this.uint32()
    else throw new MalformedPayload('Expected a string')
    const end = this.take(length)
    try {
      return this.decoder.decode(this.bytes.subarray(end - length, end))
    } catch {
      throw new MalformedPayload('A string holds invalid UTF-8')
    }
  }

  binary(): { offset: number; length: number } {
    const tag = this.byte()
    let length: number
    if (tag === 0xc4) length = this.byte()
    else if (tag === 0xc5) length = this.uint16()
    else if (tag === 0xc6) length = this.uint32()
    else throw new MalformedPayload('Expected bytes')
    const end = this.take(length)
    return { offset: end - length, length }
  }

  uint(): number {
    const tag = this.byte()
    if (tag < 0x80) return tag
    if (tag === 0xcc) return this.byte()
    if (tag === 0xcd) return this.uint16()
    if (tag === 0xce) return this.uint32()
    if (tag === 0xcf) {
      this.take(8)
      const value = this.view.getBigUint64(this.position - 8)
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MalformedPayload('An integer is out of range')
      return Number(value)
    }
    throw new MalformedPayload('Expected an unsigned integer')
  }

  private container(fix: number, sixteen: number, thirtyTwo: number, what: string): number {
    const tag = this.byte()
    if ((tag & 0xf0) === fix) return tag & 0x0f
    if (tag === sixteen) return this.uint16()
    if (tag === thirtyTwo) return this.uint32()
    throw new MalformedPayload(`Expected ${what}`)
  }

  private take(length: number): number {
    const end = this.position + length
    if (end > this.bytes.byteLength) throw new MalformedPayload('The payload ends early')
    this.position = end
    return end
  }

  private byte(): number {
    this.take(1)
    return this.bytes[this.position - 1]
  }

  private uint16(): number {
    this.take(2)
    return this.view.getUint16(this.position - 2)
  }

  private uint32(): number {
    this.take(4)
    return this.view.getUint32(this.position - 4)
  }
}
