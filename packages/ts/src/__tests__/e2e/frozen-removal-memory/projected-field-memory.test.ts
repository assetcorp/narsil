import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runCommand } from './harness'

it('releases a large projected field after the caller releases the search answer', async () => {
  const script = fileURLToPath(new URL('./projected-field-process.mjs', import.meta.url))
  const result = await runCommand(process.execPath, ['--expose-gc', script])
  expect(result.code, result.output).toBe(0)
}, 30_000)
