import type { LanguageModule } from '../../types/language'
import type { TokenizeOptions, TokenVisitor } from './tokenize'

export type PackedTokenVisitor = (records: Uint32Array, count: number, units: Uint16Array, unitCount: number) => void

export interface NativeAnalysis {
  visitTokens(
    text: string,
    language: LanguageModule,
    options: TokenizeOptions | undefined,
    visit: TokenVisitor,
    packed?: PackedTokenVisitor,
  ): boolean
  visitSpellings(text: string, language: LanguageModule, visit: (spelling: string) => void): boolean
  transform(raw: string, language: LanguageModule, stem: boolean, removeDiacritics: boolean): string | null
}

let installed: NativeAnalysis | null = null

export function installNativeAnalysis(analysis: NativeAnalysis): void {
  installed = analysis
}

export function nativeAnalysis(): NativeAnalysis | null {
  return installed
}
