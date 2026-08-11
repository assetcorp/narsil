import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import wabt from 'wabt'

const __dirname = dirname(fileURLToPath(import.meta.url))

const EXPORTED_MEMORY_DECLARATION = '(memory (export "memory") 1)'
const IMPORTED_SHARED_MEMORY_DECLARATION = '(import "env" "memory" (memory 1 65536 shared))'

interface WabtModule {
  parseWat(
    filename: string,
    source: string,
    features: Record<string, boolean>,
  ): { toBinary(options: { write_debug_names: boolean }): { buffer: Uint8Array } }
}

function compile(w: WabtModule, name: string, source: string, features: Record<string, boolean>): Uint8Array {
  const parsed = w.parseWat(name, source, features)
  const { buffer } = parsed.toBinary({ write_debug_names: false })
  const wasmBytes = Uint8Array.from(buffer)
  if (!WebAssembly.validate(wasmBytes)) {
    console.error(`${name} failed WebAssembly.validate()`)
    process.exit(1)
  }
  return wasmBytes
}

async function main() {
  const watPath = resolve(__dirname, 'simd-distance.wat')
  const outputPath = resolve(__dirname, '..', 'src', 'vector', 'simd-wasm-binary.ts')
  const watSource = readFileSync(watPath, 'utf-8')

  if (!watSource.includes(EXPORTED_MEMORY_DECLARATION)) {
    console.error(`simd-distance.wat no longer declares ${EXPORTED_MEMORY_DECLARATION}`)
    process.exit(1)
  }
  const sharedImportSource = watSource.replace(EXPORTED_MEMORY_DECLARATION, IMPORTED_SHARED_MEMORY_DECLARATION)

  const w = await wabt()
  const exportedBytes = compile(w, 'simd-distance.wat', watSource, { simd: true })
  const sharedBytes = compile(w, 'simd-distance-shared.wat', sharedImportSource, { simd: true, threads: true })

  const exportedBase64 = Buffer.from(exportedBytes).toString('base64')
  const sharedBase64 = Buffer.from(sharedBytes).toString('base64')
  const tsContent =
    `export const SIMD_DISTANCE_WASM_BASE64 =\n  '${exportedBase64}'\n\n` +
    `export const SIMD_DISTANCE_SHARED_MEMORY_WASM_BASE64 =\n  '${sharedBase64}'\n`
  writeFileSync(outputPath, tsContent)

  console.log(`Compiled ${exportedBytes.byteLength} + ${sharedBytes.byteLength} bytes -> ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
