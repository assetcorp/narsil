import type { LanguageModule } from '../types/language'

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])

function countVowels(word: string): number {
  let count = 0
  for (const ch of word) {
    if (VOWELS.has(ch)) count++
  }
  return count
}

function removeParticle(word: string): { word: string; removed: number } {
  for (const suffix of ['kah', 'lah', 'pun']) {
    if (word.endsWith(suffix)) {
      return { word: word.slice(0, -suffix.length), removed: 1 }
    }
  }
  return { word, removed: 0 }
}

function removePossessivePronoun(word: string): { word: string; removed: number } {
  if (word.endsWith('nya')) return { word: word.slice(0, -3), removed: 1 }
  if (word.endsWith('ku')) return { word: word.slice(0, -2), removed: 1 }
  if (word.endsWith('mu')) return { word: word.slice(0, -2), removed: 1 }
  return { word, removed: 0 }
}

function removeFirstPrefix(word: string): { word: string; prefixType: number } {
  if (word.startsWith('di') && word.length > 4) {
    return { word: word.slice(2), prefixType: 1 }
  }

  if (word.startsWith('ke') && word.length > 4) {
    return { word: word.slice(2), prefixType: 1 }
  }

  if (word.startsWith('se') && word.length > 4) {
    return { word: word.slice(2), prefixType: 1 }
  }

  if (word.startsWith('me')) {
    if (word.startsWith('meng') && word.length > 6) {
      const rest = word.slice(4)
      if (VOWELS.has(rest[0])) {
        return { word: rest, prefixType: 1 }
      }
      return { word: rest, prefixType: 1 }
    }
    if (word.startsWith('meny') && word.length > 6) {
      return { word: `s${word.slice(4)}`, prefixType: 3 }
    }
    if (word.startsWith('men') && word.length > 5) {
      return { word: word.slice(3), prefixType: 1 }
    }
    if (word.startsWith('mem') && word.length > 5) {
      const rest = word.slice(3)
      if (rest.length > 0 && VOWELS.has(rest[0])) {
        return { word: `p${rest}`, prefixType: 5 }
      }
      return { word: rest, prefixType: 1 }
    }
    if (word.startsWith('me') && word.length > 4) {
      return { word: word.slice(2), prefixType: 1 }
    }
  }

  if (word.startsWith('pe')) {
    if (word.startsWith('peng') && word.length > 6) {
      const rest = word.slice(4)
      if (rest.length > 0 && VOWELS.has(rest[0])) {
        return { word: rest, prefixType: 2 }
      }
      return { word: rest, prefixType: 2 }
    }
    if (word.startsWith('peny') && word.length > 6) {
      return { word: `s${word.slice(4)}`, prefixType: 4 }
    }
    if (word.startsWith('pen') && word.length > 5) {
      return { word: word.slice(3), prefixType: 2 }
    }
    if (word.startsWith('pem') && word.length > 5) {
      const rest = word.slice(3)
      if (rest.length > 0 && VOWELS.has(rest[0])) {
        return { word: `p${rest}`, prefixType: 6 }
      }
      return { word: rest, prefixType: 2 }
    }
    if (word === 'pelajar' || word.startsWith('pelajar')) {
      return { word: word.slice(3), prefixType: 1 }
    }
    if (word.startsWith('pe') && word.length > 4) {
      return { word: word.slice(2), prefixType: 2 }
    }
  }

  if (word.startsWith('ter') && word.length > 5) {
    return { word: word.slice(3), prefixType: 1 }
  }

  if (word.startsWith('ber') && word.length > 5) {
    if (word === 'belajar' || word.startsWith('belajar')) {
      return { word: word.slice(3), prefixType: 3 }
    }
    return { word: word.slice(3), prefixType: 3 }
  }

  if (word.startsWith('per') && word.length > 5) {
    return { word: word.slice(3), prefixType: 1 }
  }

  return { word, prefixType: 0 }
}

function removeDerivationalSuffix(word: string, prefixType: number): string {
  if (word.endsWith('kan') && word.length > 5) {
    if (prefixType !== 3 && prefixType !== 2) {
      return word.slice(0, -3)
    }
  }
  if (word.endsWith('an') && word.length > 4) {
    if (prefixType !== 1) {
      return word.slice(0, -2)
    }
  }
  if (word.endsWith('i') && word.length > 3) {
    const beforeI = word[word.length - 2]
    if (beforeI !== 's' && prefixType <= 2) {
      return word.slice(0, -1)
    }
  }
  return word
}

function stem(input: string): string {
  let word = input.toLowerCase()

  if (countVowels(word) < 3) return word

  const original = word

  const particle = removeParticle(word)
  word = particle.word

  const possessive = removePossessivePronoun(word)
  word = possessive.word

  if (countVowels(word) < 2) return original

  const withPrefix = removeFirstPrefix(word)
  let prefixType = withPrefix.prefixType
  const afterPrefix = withPrefix.word

  if (prefixType > 0 && countVowels(afterPrefix) >= 2) {
    word = afterPrefix

    const withSuffix = removeDerivationalSuffix(word, prefixType)
    if (withSuffix !== word && countVowels(withSuffix) >= 2) {
      word = withSuffix
    }
  } else {
    word = possessive.word

    const withSuffix = removeDerivationalSuffix(word, 0)
    if (withSuffix !== word && countVowels(withSuffix) >= 2) {
      word = withSuffix

      const secondPrefix = removeFirstPrefix(word)
      if (secondPrefix.prefixType > 0 && countVowels(secondPrefix.word) >= 2) {
        word = secondPrefix.word
        prefixType = secondPrefix.prefixType
      }
    } else {
      word = afterPrefix
      prefixType = withPrefix.prefixType

      const suffixResult = removeDerivationalSuffix(word, prefixType)
      if (suffixResult !== word && countVowels(suffixResult) >= 2) {
        word = suffixResult
      }
    }
  }

  return word
}

const stopWords = new Set([
  'ada',
  'adalah',
  'adanya',
  'adapun',
  'agak',
  'agaknya',
  'agar',
  'akan',
  'akankah',
  'akhirnya',
  'aku',
  'akulah',
  'amat',
  'amatlah',
  'anda',
  'andalah',
  'antar',
  'antara',
  'antaranya',
  'apa',
  'apaan',
  'apabila',
  'apakah',
  'apalagi',
  'apatah',
  'atau',
  'ataukah',
  'ataupun',
  'bagai',
  'bagaikan',
  'bagaimana',
  'bagaimanapun',
  'bagi',
  'bahkan',
  'bahwa',
  'bahwasanya',
  'banyak',
  'beberapa',
  'begini',
  'begitu',
  'belum',
  'belumlah',
  'berapa',
  'berapakah',
  'bermacam',
  'bersama',
  'betulkah',
  'biasa',
  'biasanya',
  'bila',
  'bilakah',
  'bisa',
  'bisakah',
  'boleh',
  'bolehkah',
  'bolehlah',
  'buat',
  'bukan',
  'bukankah',
  'bukanlah',
  'bukannya',
  'cuma',
  'dahulu',
  'dalam',
  'dan',
  'dapat',
  'dari',
  'daripada',
  'dekat',
  'demi',
  'demikian',
  'dengan',
  'depan',
  'di',
  'dia',
  'dialah',
  'diantara',
  'diantaranya',
  'dikarenakan',
  'dini',
  'diri',
  'dirinya',
  'dong',
  'dulu',
  'enggak',
  'entah',
  'hal',
  'hampir',
  'hanya',
  'hanyalah',
  'harus',
  'haruslah',
  'harusnya',
  'hendak',
  'hendaklah',
  'hendaknya',
  'hingga',
  'ia',
  'ialah',
  'ibarat',
  'ingin',
  'inginkah',
  'inginkan',
  'ini',
  'inikah',
  'inilah',
  'itu',
  'itukah',
  'itulah',
  'jangan',
  'jangankan',
  'janganlah',
  'jika',
  'jikalau',
  'juga',
  'justru',
  'kala',
  'kalau',
  'kalaulah',
  'kalaupun',
  'kalian',
  'kami',
  'kamilah',
  'kamu',
  'kamulah',
  'kan',
  'kapan',
  'kapankah',
  'kapanpun',
  'karena',
  'karenanya',
  'ke',
  'kecil',
  'kemudian',
  'kenapa',
  'kepada',
  'kepadanya',
  'ketika',
  'khususnya',
  'kini',
  'kiranya',
  'kita',
  'kitalah',
  'kok',
  'lagi',
  'lah',
  'lain',
  'lainnya',
  'lalu',
  'lama',
  'lamanya',
  'lebih',
  'macam',
  'maka',
  'makanya',
  'makin',
  'malah',
  'malahan',
  'mampu',
  'mana',
  'manakala',
  'manalagi',
  'masih',
  'masihkah',
  'masing',
  'mau',
  'maupun',
  'melainkan',
  'melalui',
  'memang',
  'mengapa',
  'mereka',
  'merekalah',
  'merupakan',
  'meski',
  'meskipun',
  'mungkin',
  'mungkinkah',
  'nah',
  'namun',
  'nanti',
  'nantinya',
  'nyaris',
  'oleh',
  'olehnya',
  'pada',
  'padahal',
  'padanya',
  'paling',
  'pantas',
  'para',
  'pasti',
  'pastilah',
  'per',
  'percuma',
  'pernah',
  'pula',
  'pun',
  'rupanya',
  'saat',
  'saatnya',
  'saja',
  'sajalah',
  'saling',
  'sama',
  'sambil',
  'sampai',
  'sana',
  'sangat',
  'sangatlah',
  'saya',
  'sayalah',
  'se',
  'sebab',
  'sebabnya',
  'sebagai',
  'sebagaimana',
  'sebagainya',
  'sebaliknya',
  'sebanyak',
  'sebegini',
  'sebegitu',
  'sebelum',
  'sebelumnya',
  'sebenarnya',
  'seberapa',
  'sebetulnya',
  'sebisanya',
  'sebuah',
  'sedang',
  'sedangkan',
  'sedemikian',
  'sedikit',
  'sedikitnya',
  'segala',
  'segalanya',
  'segera',
  'seharusnya',
  'sehingga',
  'sejak',
  'sejenak',
  'sekali',
  'sekalian',
  'sekaligus',
  'sekalipun',
  'sekarang',
  'seketika',
  'sekiranya',
  'sekitar',
  'sekitarnya',
  'selagi',
  'selain',
  'selaku',
  'selalu',
  'selama',
  'selamanya',
  'seluruh',
  'seluruhnya',
  'semacam',
  'semakin',
  'semua',
  'semuanya',
  'semula',
  'sendiri',
  'sendirinya',
  'seolah',
  'seorang',
  'sepanjang',
  'seperti',
  'sepertinya',
  'sering',
  'seringnya',
  'serta',
  'serupa',
  'sesaat',
  'sesama',
  'sesegera',
  'sesekali',
  'seseorang',
  'sesuatu',
  'sesudah',
  'sesudahnya',
  'setelah',
  'seterusnya',
  'setiap',
  'setidaknya',
  'sewaktu',
  'siapa',
  'siapakah',
  'siapapun',
  'sini',
  'sinilah',
  'suatu',
  'sudah',
  'sudahkah',
  'sudahlah',
  'supaya',
  'tadi',
  'tadinya',
  'tak',
  'tanpa',
  'tapi',
  'telah',
  'tentang',
  'tentu',
  'tentulah',
  'tentunya',
  'terdiri',
  'terhadap',
  'terhadapnya',
  'terlalu',
  'terlebih',
  'tersebut',
  'tersebutlah',
  'tertentu',
  'tetapi',
  'tiap',
  'tidak',
  'tidakkah',
  'tidaklah',
  'toh',
  'waduh',
  'wah',
  'wahai',
  'walau',
  'walaupun',
  'wong',
  'yaitu',
  'yakni',
  'yang',
])

export const indonesian: LanguageModule = {
  name: 'indonesian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9]+/gi },
}
