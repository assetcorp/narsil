import type { LanguageModule } from '../types/language'

const VERB_SUFFIXES: string[] = [
  'கிறீர்கள்',
  'கிறார்கள்',
  'ந்தீர்கள்',
  'ந்தார்கள்',
  'வீர்கள்',
  'வார்கள்',
  'கிறேன்',
  'கிறாய்',
  'கிறான்',
  'கிறாள்',
  'கிறோம்',
  'கின்றன',
  'ந்தேன்',
  'ந்தாய்',
  'ந்தான்',
  'ந்தாள்',
  'ந்தோம்',
  'கிறது',
  'ந்தது',
  'வேன்',
  'வாய்',
  'வான்',
  'வாள்',
  'வோம்',
  'ந்து',
  'த்து',
  'வது',
  'க்க',
  'ய',
]

const CASE_SUFFIXES: string[] = [
  'இடமிருந்து',
  'இருந்து',
  'உக்கு',
  'உடைய',
  'க்கு',
  'இடம்',
  'உடன்',
  'ஆல்',
  'ஒடு',
  'இன்',
  'அது',
  'இல்',
  'கண்',
  'ஓடு',
  'ஐ',
]

const POST_POSITIONS: string[] = ['பற்றி', 'மேல்', 'கீழ்', 'மீது', 'வரை']

function removeLongestSuffix(word: string, suffixes: string[], minLength: number): string {
  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= minLength) {
      return word.slice(0, word.length - suffix.length)
    }
  }
  return word
}

function stem(word: string): string {
  if (word.length < 4) return word

  if (word.endsWith('கள்') && word.length - 3 >= 2) {
    word = word.slice(0, word.length - 3)
  }

  word = removeLongestSuffix(word, CASE_SUFFIXES, 2)
  word = removeLongestSuffix(word, VERB_SUFFIXES, 2)
  word = removeLongestSuffix(word, POST_POSITIONS, 2)

  return word
}

const stopWords = new Set([
  'ஒரு',
  'என்று',
  'மற்றும்',
  'இந்த',
  'இது',
  'என்ற',
  'கொண்டு',
  'என்பது',
  'பல',
  'ஆகும்',
  'அல்லது',
  'அவர்',
  'நான்',
  'உள்ள',
  'அந்த',
  'இவர்',
  'என',
  'முதல்',
  'என்ன',
  'இருந்து',
  'சில',
  'என்',
  'போன்ற',
  'வேண்டும்',
  'வந்து',
  'இதன்',
  'அது',
  'அவன்',
  'தான்',
  'என்னும்',
  'மேலும்',
  'பின்னர்',
  'கொண்ட',
  'இருக்கும்',
  'தனது',
  'உள்ளது',
  'போது',
  'என்றும்',
  'அதன்',
  'தன்',
  'பிறகு',
  'அவர்கள்',
  'வரை',
  'அவள்',
  'நீ',
  'ஆகிய',
  'உள்ளன',
  'வந்த',
  'இருந்த',
  'மிகவும்',
  'இங்கு',
  'மீது',
  'ஓர்',
  'இவை',
  'பற்றி',
  'வரும்',
  'வேறு',
  'இரு',
  'இதில்',
  'போல்',
  'இப்போது',
  'அவரது',
  'மட்டும்',
  'எனும்',
  'மேல்',
  'பின்',
  'ஆகியோர்',
  'இன்னும்',
  'அன்று',
  'ஒரே',
  'மிக',
  'அங்கு',
  'பல்வேறு',
  'அதை',
  'பற்றிய',
  'உன்',
  'அதிக',
  'பேர்',
  'இதனால்',
  'அவை',
  'அதே',
  'ஏன்',
  'முறை',
  'யார்',
  'என்பதை',
  'எல்லாம்',
  'மட்டுமே',
  'இங்கே',
  'அங்கே',
  'இடம்',
  'அதில்',
  'நாம்',
  'அதற்கு',
  'எனவே',
  'பிற',
  'சிறு',
  'மற்ற',
  'விட',
  'எந்த',
  'அடுத்த',
  'இதனை',
  'இதை',
  'கொள்ள',
  'இதற்கு',
  'அதனால்',
  'தவிர',
  'போல',
  'சற்று',
])

export const tamil: LanguageModule = {
  name: 'tamil',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^\u0B80-\u0BFFa-z0-9]+/gi },
}
