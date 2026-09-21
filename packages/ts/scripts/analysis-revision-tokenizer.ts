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
const RUNTIME_ONLY_FUNCTIONS = new Set(['computeDefaultCacheSize'])
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

function declaresRuntimeOnlyValue(statement: ts.Statement): boolean {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name !== undefined && RUNTIME_ONLY_FUNCTIONS.has(statement.name.text)
  }
  if (!ts.isVariableStatement(statement)) return false
  return statement.declarationList.declarations.every(declaration => {
    return ts.isIdentifier(declaration.name) && RUNTIME_ONLY_CONSTANTS.has(declaration.name.text)
  })
}

/**
 * Returns the tokenizer source that can change the terms stored in an index.
 *
 * @param path - Absolute path of the tokenizer source file.
 * @param source - TypeScript source held by that file.
 * @returns Normalised TypeScript holding every statement except the cache sizes and host memory
 * thresholds, which the engine reads to size a cache and never to choose a term.
 */
export function normaliseTokenizerSource(path: string, source: string): string {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true)
  const statements = sourceFile.statements.filter(statement => !declaresRuntimeOnlyValue(statement))
  if (statements.length === sourceFile.statements.length) return printer.printFile(sourceFile)
  return printer.printFile(ts.factory.updateSourceFile(sourceFile, statements))
}
