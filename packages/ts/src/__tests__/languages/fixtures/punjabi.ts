import { punjabi } from '../../../languages/punjabi'
import { defineLanguageFixture } from './types'

const PA_LANGUAGE = "Punjabi Wikipedia, article 'ਪੰਜਾਬੀ ਭਾਸ਼ਾ' (https://pa.wikipedia.org/wiki/ਪੰਜਾਬੀ_ਭਾਸ਼ਾ)"

export const punjabiFixture = defineLanguageFixture({
  module: punjabi,
  samples: [
    {
      text: 'ਪੰਜਾਬੀ ਭਾਸ਼ਾ ਪੰਜਾਬ ਰਾਜ ਦੀ ਭਾਸ਼ਾ ਹੈ, ਜਿਸ ਨੂੰ ਪੰਜਾਬ ਖੇਤਰ ਦੇ ਵਸਨੀਕ ਜਾਂ ਸੰਬੰਧਿਤ ਲੋਕ ਬੋਲਦੇ ਹਨ।',
      source: PA_LANGUAGE,
    },
    {
      text: 'ਇਹ ਭਾਸ਼ਾਵਾਂ ਦੇ ਹਿੰਦ-ਯੂਰਪੀ ਪਰਿਵਾਰ ਵਿੱਚੋਂ ਹਿੰਦ-ਇਰਾਨੀ ਪਰਿਵਾਰ ਨਾਲ਼ ਸੰਬੰਧ ਰੱਖਦੀ ਹੈ।',
      source: PA_LANGUAGE,
    },
  ],
  indivisible: ['ਪੰਜਾਬੀ', 'ਵਸਨੀਕ', 'ਗੁਰਮੁਖੀ', 'ਪਰਿਵਾਰ'],
  separates: [
    {
      text: 'ਪੰਜਾਬ ਖੇਤਰ ਦੇ ਵਸਨੀਕ',
      tokens: ['ਪੰਜਾਬ', 'ਖੇਤਰ', 'ਦੇ', 'ਵਸਨੀਕ'],
    },
    {
      text: 'ਹਿੰਦ-ਇਰਾਨੀ ਪਰਿਵਾਰ',
      tokens: ['ਹਿੰਦ', 'ਇਰਾਨੀ', 'ਪਰਿਵਾਰ'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ਵਸਨੀਕ',
      text: 'ਪੰਜਾਬੀ ਭਾਸ਼ਾ ਪੰਜਾਬ ਰਾਜ ਦੀ ਭਾਸ਼ਾ ਹੈ, ਜਿਸ ਨੂੰ ਪੰਜਾਬ ਖੇਤਰ ਦੇ ਵਸਨੀਕ ਜਾਂ ਸੰਬੰਧਿਤ ਲੋਕ ਬੋਲਦੇ ਹਨ।',
    },
    {
      query: 'ਪਰਿਵਾਰ',
      text: 'ਇਹ ਭਾਸ਼ਾਵਾਂ ਦੇ ਹਿੰਦ-ਯੂਰਪੀ ਪਰਿਵਾਰ ਵਿੱਚੋਂ ਹਿੰਦ-ਇਰਾਨੀ ਪਰਿਵਾਰ ਨਾਲ਼ ਸੰਬੰਧ ਰੱਖਦੀ ਹੈ।',
    },
  ],
})
