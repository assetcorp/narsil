import { ErrorCodes, NarsilError } from '../errors'
import type { LanguageModule } from '../types/language'
import { english } from './english'

const languages = new Map<string, LanguageModule>()

languages.set('english', english)

/**
 * Makes a language available to indexes that name it.
 *
 * English is registered already. Every other language is its own module, so a
 * bundle carries only what you import. Import the one you want and register
 * it before you create an index that sets it as `language`.
 *
 * @param module - The language module, which registers under its own `name`.
 * Registering a name again replaces what was there.
 *
 * @public
 */
export function registerLanguage(module: LanguageModule): void {
  languages.set(module.name, module)
}

/**
 * Returns the language module registered under a name.
 *
 * @param name - The name the module registered under.
 * @returns The registered module.
 * @throws A `NarsilError` with `LANGUAGE_NOT_SUPPORTED` when nothing holds
 * that name, which usually means the module was never imported.
 *
 * @public
 */
export function getLanguage(name: string): LanguageModule {
  const lang = languages.get(name)
  if (!lang) {
    throw new NarsilError(ErrorCodes.LANGUAGE_NOT_SUPPORTED, `Language "${name}" is not registered`, { language: name })
  }
  return lang
}

export function hasLanguage(name: string): boolean {
  return languages.has(name)
}
