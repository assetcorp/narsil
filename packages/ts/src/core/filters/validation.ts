import { regionsOverlap } from '../regions'
import { typedRegion } from '../stored-values/regions'
import { MAX_OPERAND_ITEMS, MAX_PLAN_INSTRUCTIONS, MAX_PLAN_TESTS } from './constants'
import { type FilterField, fieldRegions, filterField } from './fields'
import * as L from './layout'

function validText(program: L.FilterProgram, index: number): boolean {
  if (index + 1 >= program.offsets.length) return false
  const start = program.offsets[index]
  const end = program.offsets[index + 1]
  return start <= end && end <= program.units.length && end - start <= 0x40000000
}

function validNumbers(program: L.FilterProgram, start: number, count: number, boolean: boolean): boolean {
  if (start > program.numbers.length || count > program.numbers.length - start) return false
  for (let at = start; at < start + count; at++) {
    const value = program.numbers[at]
    if (!Number.isFinite(value) || (boolean && value !== 0 && value !== 1)) return false
  }
  return true
}

function validTest(program: L.FilterProgram, field: FilterField, operator: number, operand: number): boolean {
  if (operator > L.FILTER_POLYGON) return false
  if (field.kind === L.FILTER_ABSENT) return false
  if (field.kind === L.FILTER_ENUM) {
    if (operator === L.FILTER_ANY || operator === L.FILTER_ALL) {
      if (operand * 2 + 1 >= program.lists.length) return false
      const start = program.lists[operand * 2]
      const count = program.lists[operand * 2 + 1]
      if (count > MAX_OPERAND_ITEMS || start + count >= program.offsets.length) return false
      for (let at = start; at < start + count; at++) if (!validText(program, at)) return false
      return true
    }
    return (
      (operator === L.FILTER_EQ || operator === L.FILTER_PREFIX || operator === L.FILTER_SUFFIX) &&
      validText(program, operand)
    )
  }
  if (field.kind === L.FILTER_GEO) {
    const numbers = program.numbers
    if (operator === L.FILTER_RADIUS)
      return (
        operand + 4 <= numbers.length &&
        Number.isFinite(numbers[operand]) &&
        Math.abs(numbers[operand]) <= 90 &&
        Number.isFinite(numbers[operand + 1]) &&
        Math.abs(numbers[operand + 1]) <= 180 &&
        numbers[operand + 2] >= 0 &&
        (numbers[operand + 3] === 0 || numbers[operand + 3] === 1)
      )
    if (operator !== L.FILTER_POLYGON || operand >= numbers.length) return false
    const count = numbers[operand]
    if (!Number.isInteger(count) || count < 3 || count > MAX_OPERAND_ITEMS || operand + 1 + count * 2 > numbers.length)
      return false
    for (let at = operand + 1; at < operand + 1 + count * 2; at += 2) {
      if (
        !Number.isFinite(numbers[at]) ||
        Math.abs(numbers[at]) > 90 ||
        !Number.isFinite(numbers[at + 1]) ||
        Math.abs(numbers[at + 1]) > 180
      )
        return false
    }
    return true
  }
  const boolean = field.kind === L.FILTER_BOOLEAN
  if (operator === L.FILTER_ANY || operator === L.FILTER_ALL) {
    const count = program.numbers[operand]
    return (
      Number.isInteger(count) &&
      count >= 0 &&
      count <= MAX_OPERAND_ITEMS &&
      validNumbers(program, operand + 1, count, boolean)
    )
  }
  return (
    operator <= (boolean ? L.FILTER_EQ : L.FILTER_BETWEEN) &&
    validNumbers(program, operand, operator === L.FILTER_BETWEEN ? 2 : 1, boolean)
  )
}

export function readFilterProgram(
  input: L.FilterProgram,
  output: Uint32Array,
): { program: L.FilterProgram; fields: FilterField[]; depth: number; into: Uint32Array } | null {
  const held = { ...input }
  if (!Array.isArray(held.fields) || !Array.isArray(held.bitsets)) return null
  const regions: L.FilterRegion[][] = []
  for (const field of held.fields) {
    if (!Array.isArray(field)) return null
    regions.push([...field])
  }
  const bitsetsHeld = [...held.bitsets]
  const plan = typedRegion(held.plan, 'Uint32Array')
  const numbers = typedRegion(held.numbers, 'Float64Array')
  const units = typedRegion(held.units, 'Uint16Array')
  const offsets = typedRegion(held.offsets, 'Uint32Array')
  const lists = typedRegion(held.lists, 'Uint32Array')
  const kinds = typedRegion(held.kinds, 'Uint8Array')
  const live = typedRegion(held.live, 'Uint32Array')
  const into = typedRegion(output, 'Uint32Array')
  if (
    plan === null ||
    numbers === null ||
    units === null ||
    offsets === null ||
    lists === null ||
    kinds === null ||
    live === null ||
    into === null ||
    live.length === 0 ||
    live.length > 0x8000000 ||
    plan.length % 4 !== 0 ||
    plan.length / 4 > MAX_PLAN_INSTRUCTIONS ||
    offsets.length === 0 ||
    lists.length % 2 !== 0 ||
    kinds.length !== regions.length
  )
    return null
  const bitsets: Uint32Array[] = []
  for (const value of bitsetsHeld) {
    const bits = typedRegion(value, 'Uint32Array')
    if (bits === null || bits.length === 0) return null
    bitsets.push(bits)
  }
  const inputs = [plan, numbers, units, offsets, lists, kinds, live, ...bitsets]
  if (inputs.some(region => region.length > 0xffffffff || regionsOverlap(region, into))) return null
  const fields: FilterField[] = []
  for (let at = 0; at < kinds.length; at++) {
    const field = filterField(kinds[at], regions[at])
    if (
      field === null ||
      fieldRegions(field).some(region => region.length > 0xffffffff || regionsOverlap(region, into))
    )
      return null
    fields.push(field)
  }
  const program = { plan, numbers, units, offsets, lists, kinds, live, fields: regions, bitsets }
  let depth = 0
  let maximum = 1
  let tests = 0
  for (let at = 0; at < plan.length; at += 4) {
    const opcode = plan[at]
    const field = plan[at + 1]
    const operator = plan[at + 2]
    const operand = plan[at + 3]
    if (opcode === L.FILTER_TEST) {
      if (++tests > MAX_PLAN_TESTS || field >= fields.length || !validTest(program, fields[field], operator, operand))
        return null
      depth++
    } else if (opcode === L.FILTER_PRESENT) {
      if (field >= fields.length) return null
      depth++
    } else if (opcode === L.FILTER_BITSET) {
      if (operand >= bitsets.length) return null
      depth++
    } else if (opcode === L.FILTER_NOT) {
      if (depth < 1) return null
    } else if (opcode === L.FILTER_ANDNOT) {
      if (depth < 2) return null
      depth--
    } else if (opcode === L.FILTER_AND || opcode === L.FILTER_OR) {
      if (operand < 1 || operand > depth) return null
      depth -= operand - 1
    } else return null
    maximum = Math.max(maximum, depth)
  }
  return plan.length === 0 || depth === 1 ? { program, fields, depth: maximum, into } : null
}
