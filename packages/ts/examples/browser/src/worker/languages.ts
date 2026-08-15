import { registerLanguage } from '@delali/narsil'
import { dagbani } from '@delali/narsil/languages/dagbani'
import { english } from '@delali/narsil/languages/english'
import { ewe } from '@delali/narsil/languages/ewe'
import { french } from '@delali/narsil/languages/french'
import { hausa } from '@delali/narsil/languages/hausa'
import { igbo } from '@delali/narsil/languages/igbo'
import { swahili } from '@delali/narsil/languages/swahili'
import { twi } from '@delali/narsil/languages/twi'
import { yoruba } from '@delali/narsil/languages/yoruba'
import { zulu } from '@delali/narsil/languages/zulu'
import { languageName } from '@delali/narsil-example-shared/lib/language-names'

const MODULES = [english, french, ewe, zulu, twi, yoruba, swahili, hausa, dagbani, igbo]

export { languageName }

/**
 * Registers every language this demo offers. Recovery rebuilds each index
 * under the language it was created with, so they all have to be registered
 * before the engine starts.
 */
export function registerDemoLanguages(): void {
  for (const module of MODULES) {
    registerLanguage(module)
  }
}
