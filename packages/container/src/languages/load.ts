import type { LanguageModule } from '@delali/narsil'

const LANGUAGE_SPECIFIER_PREFIX = '@delali/narsil/languages/'

export class MissingLanguageError extends Error {
  constructor(readonly language: string) {
    super(`This image holds no language module named ${language}`)
    this.name = 'MissingLanguageError'
  }
}

function isLanguageModule(value: unknown, name: string): value is LanguageModule {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<LanguageModule>
  return candidate.name === name && typeof candidate.revision === 'string' && candidate.stopWords instanceof Set
}

export async function loadLanguageModule(name: string): Promise<LanguageModule> {
  let exports: Record<string, unknown>
  try {
    exports = (await import(`${LANGUAGE_SPECIFIER_PREFIX}${name}`)) as Record<string, unknown>
  } catch {
    throw new MissingLanguageError(name)
  }
  const found = Object.values(exports).find(value => isLanguageModule(value, name))
  if (found === undefined) throw new MissingLanguageError(name)
  return found
}

export async function registerLanguages(
  names: readonly string[],
  register: (module: LanguageModule) => void,
): Promise<void> {
  const modules = await Promise.all(names.map(loadLanguageModule))
  for (const module of modules) register(module)
}
