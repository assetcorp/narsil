import ts from 'typescript'

const RUNTIME_ONLY_CONSTANTS = new Set([
  'CONSTRAINED_MEMORY_TOKEN_CACHE_FRACTION',
  'LARGE_DEVICE_TOKEN_CACHE_ENTRIES',
  'MEDIUM_DEVICE_MEMORY_GB',
  'MEDIUM_DEVICE_TOKEN_CACHE_ENTRIES',
  'NODE_TOKEN_CACHE_ENTRIES',
  'SMALL_DEVICE_MEMORY_GB',
  'SMALL_DEVICE_TOKEN_CACHE_ENTRIES',
  'TOKEN_CACHE_BYTES_PER_ENTRY',
  'TOKEN_CACHE_SIZE_CEILING',
  'TOKEN_CACHE_SIZE_FLOOR',
  'UNKNOWN_MEMORY_TOKEN_CACHE_ENTRIES',
])
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

/**
 * Returns the tokenizer source that can change the terms stored in an index.
 *
 * @param path - Absolute path of the tokenizer source file.
 * @param source - TypeScript source held by that file.
 * @param constantsPath - Absolute path of the tokenizer constants file.
 * @returns Normalised TypeScript containing every statement except runtime-only tuning constants.
 */
export function normaliseTokenizerSource(path: string, source: string, constantsPath: string): string {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true)
  if (path !== constantsPath) return printer.printFile(sourceFile)
  const statements = sourceFile.statements.filter(statement => {
    if (!ts.isVariableStatement(statement)) return true
    return statement.declarationList.declarations.some(declaration => {
      return !ts.isIdentifier(declaration.name) || !RUNTIME_ONLY_CONSTANTS.has(declaration.name.text)
    })
  })
  return printer.printFile(ts.factory.updateSourceFile(sourceFile, statements))
}
