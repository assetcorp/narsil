/**
 * The typed regions of one stored field in a shared ordinal space.
 *
 * @internal
 */
export interface NativeStoredValues {
  /** Records 0 for an absent field, 1 for a scalar, and 2 for an array at each ordinal. */
  shapes: Uint8Array
  /** Gives each ordinal's first value, followed by the terminal value offset. */
  starts: Uint32Array
  /** Records 0 for null, 1 for false, 2 for true, 3 for a number, 4 for a string, and 5 for encoded data. */
  kinds: Uint8Array
  /** Holds each numeric value at its value position. */
  numbers: Float64Array
  /** Gives each string's first code unit or each encoded value's first byte. */
  textStart: Uint32Array
  /** Gives each string's code unit count or each encoded value's byte count. */
  textLength: Uint32Array
  /** Holds the UTF-16 code units of the strings. */
  units: Uint16Array
  /** Holds the MessagePack bytes of objects and nested arrays. */
  bytes: Uint8Array
}
