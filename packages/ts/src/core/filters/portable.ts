import { bitsetAndInto, bitsetAndNotInto, bitsetOrInto } from '../bitset'
import * as L from './layout'
import { filterTest } from './tests'
import { readFilterProgram } from './validation'

export function evaluateFilter(input: L.FilterProgram, output: Uint32Array): number {
  const checked = readFilterProgram(input, output)
  if (checked === null) return -1
  const { program, fields, depth, into } = checked
  const { live, plan } = program
  if (into.length < live.length) return -3
  if (plan.length === 0) {
    into.set(live)
    return 0
  }
  const storage = new Uint32Array(live.length * (depth + 1))
  const stack = Array.from({ length: depth }, (_, at) => storage.subarray(at * live.length, (at + 1) * live.length))
  const scratch = storage.subarray(depth * live.length)
  let count = 0
  for (let at = 0; at < plan.length; at += 4) {
    const opcode = plan[at]
    const field = plan[at + 1]
    const operator = plan[at + 2]
    const operand = plan[at + 3]
    if (opcode === L.FILTER_TEST) filterTest(program, fields[field], operator, operand, stack[count++], scratch)
    else if (opcode === L.FILTER_BITSET || opcode === L.FILTER_PRESENT) {
      const source = opcode === L.FILTER_BITSET ? program.bitsets[operand] : fields[field].present
      const bits = stack[count++]
      bits.fill(0)
      bits.set(source.subarray(0, bits.length))
    } else if (opcode === L.FILTER_NOT) {
      const bits = stack[count - 1]
      for (let word = 0; word < live.length; word++) bits[word] = live[word] & ~bits[word]
    } else if (opcode === L.FILTER_ANDNOT) {
      bitsetAndNotInto(stack[count - 2], stack[count - 1])
      count--
    } else {
      const first = count - operand
      for (let entry = first + 1; entry < count; entry++) {
        if (opcode === L.FILTER_AND) bitsetAndInto(stack[first], stack[entry])
        else bitsetOrInto(stack[first], stack[entry])
      }
      count = first + 1
    }
  }
  for (let word = 0; word < live.length; word++) into[word] = stack[0][word] & live[word]
  return 0
}
