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
  for (const suffix of ['kah', 'lah', 'tah', 'pun']) {
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
      return { word: word.slice(4), prefixType: 1 }
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
      return { word: word.slice(4), prefixType: 2 }
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

  if (word.startsWith('belajar')) {
    return { word: word.slice(3), prefixType: 3 }
  }

  if (word.startsWith('ber') && word.length > 5) {
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

// Stop words sourced from https://github.com/stopwords-iso/stopwords-id
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
  'akhir',
  'akhiri',
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
  'artinya',
  'asal',
  'asalkan',
  'atas',
  'atau',
  'ataukah',
  'ataupun',
  'awal',
  'awalnya',
  'bagai',
  'bagaikan',
  'bagaimana',
  'bagaimanakah',
  'bagaimanapun',
  'bagi',
  'bagian',
  'bahkan',
  'bahwa',
  'bahwasanya',
  'baik',
  'bakal',
  'bakalan',
  'balik',
  'banyak',
  'bapak',
  'baru',
  'bawah',
  'beberapa',
  'begini',
  'beginian',
  'beginikah',
  'beginilah',
  'begitu',
  'begitukah',
  'begitulah',
  'begitupun',
  'bekerja',
  'belakang',
  'belakangan',
  'belum',
  'belumlah',
  'benar',
  'benarkah',
  'benarlah',
  'berada',
  'berakhir',
  'berakhirlah',
  'berakhirnya',
  'berapa',
  'berapakah',
  'berapalah',
  'berapapun',
  'berarti',
  'berawal',
  'berbagai',
  'berdatangan',
  'beri',
  'berikan',
  'berikut',
  'berikutnya',
  'berjumlah',
  'berkata',
  'berkehendak',
  'berkeinginan',
  'berkenaan',
  'berlainan',
  'berlalu',
  'berlangsung',
  'berlebihan',
  'bermacam',
  'bermaksud',
  'bermula',
  'bersama',
  'bersiap',
  'bertanya',
  'berturut',
  'bertutur',
  'berujar',
  'berupa',
  'besar',
  'betul',
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
  'bulan',
  'bung',
  'cara',
  'caranya',
  'cukup',
  'cukupkah',
  'cukuplah',
  'cuma',
  'dahulu',
  'dalam',
  'dan',
  'dapat',
  'dari',
  'daripada',
  'datang',
  'dekat',
  'demi',
  'demikian',
  'demikianlah',
  'dengan',
  'depan',
  'di',
  'dia',
  'diakhiri',
  'diakhirinya',
  'dialah',
  'diantara',
  'diantaranya',
  'diberi',
  'diberikan',
  'diberikannya',
  'dibuat',
  'dibuatnya',
  'didapat',
  'didatangkan',
  'digunakan',
  'diibaratkan',
  'diibaratkannya',
  'diingat',
  'diingatkan',
  'diinginkan',
  'dijawab',
  'dijelaskan',
  'dijelaskannya',
  'dikarenakan',
  'dikatakan',
  'dikatakannya',
  'dikerjakan',
  'diketahui',
  'diketahuinya',
  'dikira',
  'dilakukan',
  'dilalui',
  'dilihat',
  'dimaksud',
  'dimaksudkan',
  'dimaksudkannya',
  'dimaksudnya',
  'diminta',
  'dimintai',
  'dimisalkan',
  'dimulai',
  'dimulailah',
  'dimulainya',
  'dimungkinkan',
  'dini',
  'dipastikan',
  'diperbuat',
  'diperbuatnya',
  'dipergunakan',
  'diperkirakan',
  'diperlihatkan',
  'diperlukan',
  'diperlukannya',
  'dipersoalkan',
  'dipertanyakan',
  'dipunyai',
  'diri',
  'dirinya',
  'disampaikan',
  'disebut',
  'disebutkan',
  'disebutkannya',
  'disini',
  'disinilah',
  'ditambahkan',
  'ditandaskan',
  'ditanya',
  'ditanyai',
  'ditanyakan',
  'ditegaskan',
  'ditujukan',
  'ditunjuk',
  'ditunjuki',
  'ditunjukkan',
  'ditunjukkannya',
  'ditunjuknya',
  'dituturkan',
  'dituturkannya',
  'diucapkan',
  'diucapkannya',
  'diungkapkan',
  'dong',
  'dua',
  'dulu',
  'empat',
  'enggak',
  'enggaknya',
  'entah',
  'entahlah',
  'guna',
  'gunakan',
  'hal',
  'hampir',
  'hanya',
  'hanyalah',
  'hari',
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
  'ibaratkan',
  'ibaratnya',
  'ibu',
  'ikut',
  'ingat',
  'ingin',
  'inginkah',
  'inginkan',
  'ini',
  'inikah',
  'inilah',
  'itu',
  'itukah',
  'itulah',
  'jadi',
  'jadilah',
  'jadinya',
  'jangan',
  'jangankan',
  'janganlah',
  'jauh',
  'jawab',
  'jawaban',
  'jawabnya',
  'jelas',
  'jelaskan',
  'jelaslah',
  'jelasnya',
  'jika',
  'jikalau',
  'juga',
  'jumlah',
  'jumlahnya',
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
  'kasus',
  'kata',
  'katakan',
  'katakanlah',
  'katanya',
  'ke',
  'keadaan',
  'kebetulan',
  'kecil',
  'kedua',
  'keduanya',
  'keinginan',
  'kelamaan',
  'kelihatan',
  'kelihatannya',
  'kelima',
  'keluar',
  'kembali',
  'kemudian',
  'kemungkinan',
  'kemungkinannya',
  'kenapa',
  'kepada',
  'kepadanya',
  'kesampaian',
  'keseluruhan',
  'keseluruhannya',
  'keterlaluan',
  'ketika',
  'khususnya',
  'kini',
  'kinilah',
  'kira',
  'kiranya',
  'kita',
  'kitalah',
  'kok',
  'kurang',
  'lagi',
  'lagian',
  'lah',
  'lain',
  'lainnya',
  'lalu',
  'lama',
  'lamanya',
  'lanjut',
  'lanjutnya',
  'lebih',
  'lewat',
  'lima',
  'luar',
  'macam',
  'maka',
  'makanya',
  'makin',
  'malah',
  'malahan',
  'mampu',
  'mampukah',
  'mana',
  'manakala',
  'manalagi',
  'masa',
  'masalah',
  'masalahnya',
  'masih',
  'masihkah',
  'masing',
  'mau',
  'maupun',
  'melainkan',
  'melakukan',
  'melalui',
  'melihat',
  'melihatnya',
  'memang',
  'memastikan',
  'memberi',
  'memberikan',
  'membuat',
  'memerlukan',
  'memihak',
  'meminta',
  'memintakan',
  'memisalkan',
  'memperbuat',
  'mempergunakan',
  'memperkirakan',
  'memperlihatkan',
  'mempersiapkan',
  'mempersoalkan',
  'mempertanyakan',
  'mempunyai',
  'memulai',
  'memungkinkan',
  'menaiki',
  'menambahkan',
  'menandaskan',
  'menanti',
  'menantikan',
  'menanya',
  'menanyai',
  'menanyakan',
  'mendapat',
  'mendapatkan',
  'mendatang',
  'mendatangi',
  'mendatangkan',
  'menegaskan',
  'mengakhiri',
  'mengapa',
  'mengatakan',
  'mengatakannya',
  'mengenai',
  'mengerjakan',
  'mengetahui',
  'menggunakan',
  'menghendaki',
  'mengibaratkan',
  'mengibaratkannya',
  'mengingat',
  'mengingatkan',
  'menginginkan',
  'mengira',
  'mengucapkan',
  'mengucapkannya',
  'mengungkapkan',
  'menjadi',
  'menjawab',
  'menjelaskan',
  'menuju',
  'menunjuk',
  'menunjuki',
  'menunjukkan',
  'menunjuknya',
  'menurut',
  'menuturkan',
  'menyampaikan',
  'menyangkut',
  'menyatakan',
  'menyebutkan',
  'menyeluruh',
  'menyiapkan',
  'merasa',
  'mereka',
  'merekalah',
  'merupakan',
  'meski',
  'meskipun',
  'meyakini',
  'meyakinkan',
  'minta',
  'mirip',
  'misal',
  'misalkan',
  'misalnya',
  'mula',
  'mulai',
  'mulailah',
  'mulanya',
  'mungkin',
  'mungkinkah',
  'nah',
  'naik',
  'namun',
  'nanti',
  'nantinya',
  'nyaris',
  'nyatanya',
  'oleh',
  'olehnya',
  'pada',
  'padahal',
  'padanya',
  'pak',
  'paling',
  'panjang',
  'pantas',
  'para',
  'pasti',
  'pastilah',
  'penting',
  'pentingnya',
  'per',
  'percuma',
  'perlu',
  'perlukah',
  'perlunya',
  'pernah',
  'persoalan',
  'pertama',
  'pertanyaan',
  'pertanyakan',
  'pihak',
  'pihaknya',
  'pukul',
  'pula',
  'pun',
  'punya',
  'rasa',
  'rasanya',
  'rata',
  'rupanya',
  'saat',
  'saatnya',
  'saja',
  'sajalah',
  'saling',
  'sama',
  'sambil',
  'sampai',
  'sampaikan',
  'sana',
  'sangat',
  'sangatlah',
  'satu',
  'saya',
  'sayalah',
  'se',
  'sebab',
  'sebabnya',
  'sebagai',
  'sebagaimana',
  'sebagainya',
  'sebagian',
  'sebaik',
  'sebaiknya',
  'sebaliknya',
  'sebanyak',
  'sebegini',
  'sebegitu',
  'sebelum',
  'sebelumnya',
  'sebenarnya',
  'seberapa',
  'sebesar',
  'sebetulnya',
  'sebisanya',
  'sebuah',
  'sebut',
  'sebutlah',
  'sebutnya',
  'secara',
  'secukupnya',
  'sedang',
  'sedangkan',
  'sedemikian',
  'sedikit',
  'sedikitnya',
  'seenaknya',
  'segala',
  'segalanya',
  'segera',
  'seharusnya',
  'sehingga',
  'seingat',
  'sejak',
  'sejauh',
  'sejenak',
  'sejumlah',
  'sekadar',
  'sekadarnya',
  'sekali',
  'sekalian',
  'sekaligus',
  'sekalipun',
  'sekarang',
  'sekecil',
  'seketika',
  'sekiranya',
  'sekitar',
  'sekitarnya',
  'sekurangnya',
  'sela',
  'selagi',
  'selain',
  'selaku',
  'selalu',
  'selama',
  'selamanya',
  'selanjutnya',
  'seluruh',
  'seluruhnya',
  'semacam',
  'semakin',
  'semampu',
  'semampunya',
  'semasa',
  'semasih',
  'semata',
  'semaunya',
  'sementara',
  'semisal',
  'semisalnya',
  'sempat',
  'semua',
  'semuanya',
  'semula',
  'sendiri',
  'sendirian',
  'sendirinya',
  'seolah',
  'seorang',
  'sepanjang',
  'sepantasnya',
  'sepantasnyalah',
  'seperlunya',
  'seperti',
  'sepertinya',
  'sepihak',
  'sering',
  'seringnya',
  'serta',
  'serupa',
  'sesaat',
  'sesama',
  'sesampai',
  'sesegera',
  'sesekali',
  'seseorang',
  'sesuatu',
  'sesuatunya',
  'sesudah',
  'sesudahnya',
  'setelah',
  'setempat',
  'setengah',
  'seterusnya',
  'setiap',
  'setiba',
  'setibanya',
  'setidaknya',
  'setinggi',
  'seusai',
  'sewaktu',
  'siap',
  'siapa',
  'siapakah',
  'siapapun',
  'sini',
  'sinilah',
  'soal',
  'soalnya',
  'suatu',
  'sudah',
  'sudahkah',
  'sudahlah',
  'supaya',
  'tadi',
  'tadinya',
  'tahu',
  'tahun',
  'tak',
  'tambah',
  'tambahnya',
  'tampak',
  'tampaknya',
  'tandas',
  'tandasnya',
  'tanpa',
  'tanya',
  'tanyakan',
  'tanyanya',
  'tapi',
  'tegas',
  'tegasnya',
  'telah',
  'tempat',
  'tengah',
  'tentang',
  'tentu',
  'tentulah',
  'tentunya',
  'tepat',
  'terakhir',
  'terasa',
  'terbanyak',
  'terdahulu',
  'terdapat',
  'terdiri',
  'terhadap',
  'terhadapnya',
  'teringat',
  'terjadi',
  'terjadilah',
  'terjadinya',
  'terkira',
  'terlalu',
  'terlebih',
  'terlihat',
  'termasuk',
  'ternyata',
  'tersampaikan',
  'tersebut',
  'tersebutlah',
  'tertentu',
  'tertuju',
  'terus',
  'terutama',
  'tetap',
  'tetapi',
  'tiap',
  'tiba',
  'tidak',
  'tidakkah',
  'tidaklah',
  'tiga',
  'tinggi',
  'toh',
  'tunjuk',
  'turut',
  'tutur',
  'tuturnya',
  'ucap',
  'ucapnya',
  'ujar',
  'ujarnya',
  'umum',
  'umumnya',
  'ungkap',
  'ungkapnya',
  'untuk',
  'usah',
  'usai',
  'waduh',
  'wah',
  'wahai',
  'waktu',
  'waktunya',
  'walau',
  'walaupun',
  'wong',
  'yaitu',
  'yakin',
  'yakni',
  'yang',
])

export const indonesian: LanguageModule = {
  name: 'indonesian',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^a-z0-9]+/gi },
}
