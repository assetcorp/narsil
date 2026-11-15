import { registerLanguage } from '@delali/narsil'
import { readSettings } from '../settings'
import { registerLanguages } from './load'

await registerLanguages(readSettings(process.env).engine.languages, registerLanguage)
