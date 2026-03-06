import { ErrorCodes, NarsilError } from '../errors'
import type { LanguageModule } from '../types/language'
import { english } from './english'

const languages = new Map<string, LanguageModule>()

languages.set('english', english)

export function registerLanguage(module: LanguageModule): void {
  languages.set(module.name, module)
}

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
