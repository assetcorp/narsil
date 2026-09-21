import { execFileSync } from 'node:child_process'
import { lintTools } from './lint-tools.mjs'
import { formattedFiles } from './toolchain.mjs'

const { clangFormat } = lintTools()
execFileSync(clangFormat, ['-i', '--style=file', ...formattedFiles()], { stdio: 'inherit' })
