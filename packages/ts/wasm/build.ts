import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import wabt from 'wabt'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const watPath = resolve(__dirname, 'simd-distance.wat')
  const outputPath = resolve(__dirname, '..', 'src', 'vector', 'simd-wasm-binary.ts')
  const watSource = readFileSync(watPath, 'utf-8')

  const w = await wabt()
  const parsed = w.parseWat('simd-distance.wat', watSource, { simd: true })
  const { buffer } = parsed.toBinary({ write_debug_names: false })
  const wasmBytes = Uint8Array.from(buffer)

  if (!WebAssembly.validate(wasmBytes)) {
    console.error('Produced WASM binary failed WebAssembly.validate()')
    process.exit(1)
  }

  const base64 = Buffer.from(wasmBytes).toString('base64')
  const tsContent = `export const SIMD_DISTANCE_WASM_BASE64 = '${base64}'\n`
  writeFileSync(outputPath, tsContent)

  console.log(`Compiled ${wasmBytes.byteLength} bytes -> ${outputPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
