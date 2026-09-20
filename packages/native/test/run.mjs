import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDirectory,
  coreSources,
  LANGUAGE_FLAGS,
  TEST_FLAGS,
  TEST_LINK_FLAGS,
  testSources,
  warningFlags,
} from '../toolchain.mjs'

const testBuildDirectory = join(buildDirectory, 'test')
mkdirSync(testBuildDirectory, { recursive: true })

const TEST_TIMEOUT_MS = 120_000
const sanitisers = process.platform === 'linux' ? 'address,undefined' : 'undefined'

const variants = [
  { name: 'platform-kernels', flags: [] },
  { name: 'portable-kernels', flags: ['-DNARSIL_PORTABLE_KERNELS'] },
]

for (const variant of variants) {
  const binary = join(testBuildDirectory, variant.name)
  execFileSync(
    'cc',
    [
      ...LANGUAGE_FLAGS,
      ...TEST_FLAGS,
      ...warningFlags('cc'),
      `-fsanitize=${sanitisers}`,
      '-fno-sanitize-recover=undefined',
      '-fno-omit-frame-pointer',
      ...variant.flags,
      ...TEST_LINK_FLAGS,
      '-o',
      binary,
      ...testSources(),
      ...coreSources(),
      '-lm',
    ],
    { stdio: 'inherit' },
  )
  execFileSync(binary, [], { stdio: 'inherit', timeout: TEST_TIMEOUT_MS })
  console.log(`The ${variant.name} test passed under -fsanitize=${sanitisers}`)
}
