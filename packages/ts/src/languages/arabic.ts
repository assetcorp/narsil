import type { LanguageModule } from '../types/language'

const DIACRITICS = new Set(['\u0640', '\u064B', '\u064C', '\u064D', '\u064E', '\u064F', '\u0650', '\u0651', '\u0652'])

const ARABIC_INDIC_DIGITS: Record<string, string> = {
  '\u0660': '0',
  '\u0661': '1',
  '\u0662': '2',
  '\u0663': '3',
  '\u0664': '4',
  '\u0665': '5',
  '\u0666': '6',
  '\u0667': '7',
  '\u0668': '8',
  '\u0669': '9',
}

function normalize(word: string): string {
  let result = ''
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    const code = ch.charCodeAt(0)

    if (DIACRITICS.has(ch)) continue

    if (code >= 0xfe70 && code <= 0xfeff) {
      result += mapPresentationForm(code)
      continue
    }

    if (ch in ARABIC_INDIC_DIGITS) {
      result += ARABIC_INDIC_DIGITS[ch]
      continue
    }

    switch (ch) {
      case '\u0622':
      case '\u0623':
      case '\u0625':
        result += '\u0627'
        break
      case '\u0624':
        result += '\u0648'
        break
      case '\u0626':
        result += '\u064A'
        break
      default:
        result += ch
    }
  }
  return result
}

function mapPresentationForm(code: number): string {
  if (code >= 0xfe80 && code <= 0xfe84) return '\u0627'
  if (code >= 0xfe85 && code <= 0xfe86) return '\u0648'
  if (code >= 0xfe87 && code <= 0xfe88) return '\u0627'
  if (code >= 0xfe89 && code <= 0xfe8c) return '\u064A'
  if (code >= 0xfe8d && code <= 0xfe8e) return '\u0627'
  if (code >= 0xfe8f && code <= 0xfe92) return '\u0628'
  if (code >= 0xfe93 && code <= 0xfe94) return '\u0629'
  if (code >= 0xfe95 && code <= 0xfe98) return '\u062A'
  if (code >= 0xfe99 && code <= 0xfe9c) return '\u062B'
  if (code >= 0xfe9d && code <= 0xfea0) return '\u062C'
  if (code >= 0xfea1 && code <= 0xfea4) return '\u062D'
  if (code >= 0xfea5 && code <= 0xfea8) return '\u062E'
  if (code >= 0xfea9 && code <= 0xfeaa) return '\u062F'
  if (code >= 0xfeab && code <= 0xfeac) return '\u0630'
  if (code >= 0xfead && code <= 0xfeae) return '\u0631'
  if (code >= 0xfeaf && code <= 0xfeb0) return '\u0632'
  if (code >= 0xfeb1 && code <= 0xfeb4) return '\u0633'
  if (code >= 0xfeb5 && code <= 0xfeb8) return '\u0634'
  if (code >= 0xfeb9 && code <= 0xfebc) return '\u0635'
  if (code >= 0xfebd && code <= 0xfec0) return '\u0636'
  if (code >= 0xfec1 && code <= 0xfec4) return '\u0637'
  if (code >= 0xfec5 && code <= 0xfec8) return '\u0638'
  if (code >= 0xfec9 && code <= 0xfecc) return '\u0639'
  if (code >= 0xfecd && code <= 0xfed0) return '\u063A'
  if (code >= 0xfed1 && code <= 0xfed4) return '\u0641'
  if (code >= 0xfed5 && code <= 0xfed8) return '\u0642'
  if (code >= 0xfed9 && code <= 0xfedc) return '\u0643'
  if (code >= 0xfedd && code <= 0xfee0) return '\u0644'
  if (code >= 0xfee1 && code <= 0xfee4) return '\u0645'
  if (code >= 0xfee5 && code <= 0xfee8) return '\u0646'
  if (code >= 0xfee9 && code <= 0xfeec) return '\u0647'
  if (code >= 0xfeed && code <= 0xfeee) return '\u0648'
  if (code >= 0xfeef && code <= 0xfef0) return '\u0649'
  if (code >= 0xfef1 && code <= 0xfef4) return '\u064A'
  if (code >= 0xfef5 && code <= 0xfefc) return '\u0644\u0627'
  return String.fromCharCode(code)
}

function removePrefixes(word: string): string {
  if (word.startsWith('\u0628\u0627\u0644') && word.length > 6) {
    return word.slice(3)
  }
  if (word.startsWith('\u0643\u0627\u0644') && word.length > 6) {
    return word.slice(3)
  }
  if (word.startsWith('\u0627\u0644') && word.length > 5) {
    return word.slice(2)
  }
  if (word.startsWith('\u0644\u0644') && word.length > 5) {
    return word.slice(2)
  }
  if (word.startsWith('\u0648') && word.length > 4) {
    return word.slice(1)
  }
  if (word.startsWith('\u0641') && word.length > 4) {
    return word.slice(1)
  }
  return word
}

function removeObjectPronouns(word: string): string {
  if (word.length >= 6) {
    if (word.endsWith('\u0643\u0645\u0627')) return word.slice(0, -3)
    if (word.endsWith('\u0647\u0645\u0627')) return word.slice(0, -3)
  }
  if (word.length >= 5) {
    if (word.endsWith('\u0646\u0627')) return word.slice(0, -2)
    if (word.endsWith('\u0647\u0627')) return word.slice(0, -2)
    if (word.endsWith('\u0643\u0645')) return word.slice(0, -2)
    if (word.endsWith('\u0647\u0645')) return word.slice(0, -2)
    if (word.endsWith('\u0647\u0646')) return word.slice(0, -2)
  }
  if (word.length >= 4) {
    if (word.endsWith('\u0643')) return word.slice(0, -1)
    if (word.endsWith('\u0647')) return word.slice(0, -1)
    if (word.endsWith('\u064A')) return word.slice(0, -1)
  }
  return word
}

function removeVerbSuffixes(word: string): string {
  if (word.length >= 5) {
    if (word.endsWith('\u062A\u0645\u0627')) return word.slice(0, -3)
  }
  if (word.length >= 4) {
    if (word.endsWith('\u0627\u0646')) return word.slice(0, -2)
    if (word.endsWith('\u062A\u0627')) return word.slice(0, -2)
    if (word.endsWith('\u062A\u0646')) return word.slice(0, -2)
    if (word.endsWith('\u0648\u0646')) return word.slice(0, -2)
    if (word.endsWith('\u064A\u0646')) return word.slice(0, -2)
    if (word.endsWith('\u0648\u0627')) return word.slice(0, -2)
    if (word.endsWith('\u062A\u0645')) return word.slice(0, -2)
  }
  if (word.length >= 4) {
    if (word.endsWith('\u062A')) return word.slice(0, -1)
    if (word.endsWith('\u0627')) return word.slice(0, -1)
    if (word.endsWith('\u0646')) return word.slice(0, -1)
  }
  return word
}

function removeNounSuffixes(word: string): string {
  if (word.length >= 4) {
    if (word.endsWith('\u0627\u062A')) return word.slice(0, -2)
    if (word.endsWith('\u0629')) return word.slice(0, -1)
    if (word.endsWith('\u064A')) return word.slice(0, -1)
  }
  return word
}

function stem(word: string): string {
  if (word.length < 3) return word
  word = normalize(word)
  word = removePrefixes(word)
  word = removeObjectPronouns(word)
  word = removeVerbSuffixes(word)
  word = removeNounSuffixes(word)
  return word
}

// Stop words sourced from https://github.com/stopwords-iso/stopwords-ar
const stopWords = new Set([
  '\u0623\u0644\u0627',
  '\u0623\u0645\u0627',
  '\u0623\u0646',
  '\u0623\u0646\u0627',
  '\u0623\u0646\u062A',
  '\u0623\u0646\u062A\u0645',
  '\u0623\u0648',
  '\u0623\u0648\u0644\u0626\u0643',
  '\u0623\u064A',
  '\u0623\u064A\u0636\u0627',
  '\u0623\u064A\u0646',
  '\u0625\u0630',
  '\u0625\u0630\u0627',
  '\u0625\u0644\u0627',
  '\u0625\u0644\u0649',
  '\u0625\u0645\u0627',
  '\u0625\u0646',
  '\u0627\u0644\u062A\u064A',
  '\u0627\u0644\u0630\u064A',
  '\u0627\u0644\u0630\u064A\u0646',
  '\u0628\u0639\u062F',
  '\u0628\u0639\u0636',
  '\u0628\u0644',
  '\u0628\u064A\u0646',
  '\u062A\u062D\u062A',
  '\u062A\u0644\u0643',
  '\u062B\u0645',
  '\u062D\u062A\u0649',
  '\u062D\u0648\u0644',
  '\u062D\u064A\u062B',
  '\u062E\u0644\u0627\u0644',
  '\u0630\u0644\u0643',
  '\u0633\u0648\u0641',
  '\u0633\u0648\u0649',
  '\u0636\u062F',
  '\u0639\u0628\u0631',
  '\u0639\u0644\u0649',
  '\u0639\u0646',
  '\u0639\u0646\u062F',
  '\u063A\u064A\u0631',
  '\u0641\u0625\u0646',
  '\u0641\u0642\u0637',
  '\u0641\u0648\u0642',
  '\u0641\u064A',
  '\u0642\u0628\u0644',
  '\u0642\u062F',
  '\u0643\u0623\u0646',
  '\u0643\u0627\u0646',
  '\u0643\u0627\u0646\u062A',
  '\u0643\u0644',
  '\u0643\u0645\u0627',
  '\u0643\u064A\u0641',
  '\u0644\u0627',
  '\u0644\u062F\u0649',
  '\u0644\u0639\u0644',
  '\u0644\u0643\u0646',
  '\u0644\u0643\u064A',
  '\u0644\u0645',
  '\u0644\u0645\u0627\u0630\u0627',
  '\u0644\u0646',
  '\u0644\u0648',
  '\u0644\u0648\u0644\u0627',
  '\u0644\u064A\u062A',
  '\u0644\u064A\u0633',
  '\u0645\u0627',
  '\u0645\u062A\u0649',
  '\u0645\u062B\u0644',
  '\u0645\u0639',
  '\u0645\u0645\u0627',
  '\u0645\u0646',
  '\u0645\u0646\u0630',
  '\u0646\u062D\u0646',
  '\u0646\u0641\u0633',
  '\u0647\u0624\u0644\u0627\u0621',
  '\u0647\u0627\u062A\u0627\u0646',
  '\u0647\u0630\u0627',
  '\u0647\u0630\u0627\u0646',
  '\u0647\u0630\u0647',
  '\u0647\u0644',
  '\u0647\u0645',
  '\u0647\u0646',
  '\u0647\u0646\u0627',
  '\u0647\u0646\u0627\u0643',
  '\u0647\u0648',
  '\u0647\u064A',
  '\u0648\u0625\u0646',
  '\u0648\u0644\u0627',
  '\u064A\u0643\u0648\u0646',
  'آض',
  'آمين',
  'آه',
  'آها',
  'آي',
  'أ',
  'أب',
  'أجل',
  'أجمع',
  'أخ',
  'أخذ',
  'أصبح',
  'أضحى',
  'أف',
  'أقبل',
  'أقل',
  'أكثر',
  'أم',
  'أمامك',
  'أمسى',
  'أنتما',
  'أنتن',
  'أنشأ',
  'أنى',
  'أوشك',
  'أولئكم',
  'أولاء',
  'أولالك',
  'أوه',
  'أيا',
  'أيان',
  'أينما',
  'إذما',
  'إذن',
  'إليك',
  'إليكم',
  'إليكما',
  'إليكن',
  'إنما',
  'إي',
  'إياك',
  'إياكم',
  'إياكما',
  'إياكن',
  'إيانا',
  'إياه',
  'إياها',
  'إياهم',
  'إياهما',
  'إياهن',
  'إياي',
  'إيه',
  'ا',
  'ابتدأ',
  'اثر',
  'اجل',
  'احد',
  'اخرى',
  'اخلولق',
  'اذا',
  'اربعة',
  'ارتد',
  'استحال',
  'اطار',
  'اعادة',
  'اعلنت',
  'اف',
  'اكثر',
  'اكد',
  'الألاء',
  'الألى',
  'الا',
  'الاخيرة',
  'الان',
  'الاول',
  'الاولى',
  'التى',
  'الثاني',
  'الثانية',
  'الذاتي',
  'الذى',
  'السابق',
  'الف',
  'اللائي',
  'اللاتي',
  'اللتان',
  'اللتيا',
  'اللتين',
  'اللذان',
  'اللذين',
  'اللواتي',
  'الماضي',
  'المقبل',
  'الوقت',
  'الى',
  'اليوم',
  'اما',
  'امام',
  'امس',
  'ان',
  'انبرى',
  'انقلب',
  'انه',
  'انها',
  'او',
  'اول',
  'اي',
  'ايار',
  'ايام',
  'ايضا',
  'ب',
  'بئس',
  'بات',
  'باسم',
  'بان',
  'بخ',
  'برس',
  'بس',
  'بسبب',
  'بشكل',
  'بضع',
  'بطآن',
  'بك',
  'بكم',
  'بكما',
  'بكن',
  'بله',
  'بلى',
  'بما',
  'بماذا',
  'بمن',
  'بن',
  'بنا',
  'به',
  'بها',
  'بي',
  'بيد',
  'تان',
  'تانك',
  'تبدل',
  'تجاه',
  'تحول',
  'تلقاء',
  'تلكم',
  'تلكما',
  'تم',
  'ته',
  'تي',
  'تين',
  'تينك',
  'ثلاثة',
  'ثمة',
  'جعل',
  'جلل',
  'جميع',
  'جير',
  'حار',
  'حاشا',
  'حاليا',
  'حاي',
  'حبذا',
  'حذار',
  'حرى',
  'حسب',
  'حم',
  'حوالى',
  'حي',
  'حيثما',
  'حين',
  'خلا',
  'دون',
  'دونك',
  'ذا',
  'ذات',
  'ذاك',
  'ذان',
  'ذانك',
  'ذلكم',
  'ذلكما',
  'ذلكن',
  'ذه',
  'ذو',
  'ذوا',
  'ذواتا',
  'ذواتي',
  'ذي',
  'ذيت',
  'ذين',
  'ذينك',
  'راح',
  'رب',
  'رجع',
  'رويدك',
  'ريث',
  'زيارة',
  'ساء',
  'ساءما',
  'سبحان',
  'سرعان',
  'سنة',
  'سنوات',
  'شبه',
  'شتان',
  'شخصا',
  'شرع',
  'صار',
  'صباح',
  'صفر',
  'صه',
  'ضمن',
  'طاق',
  'طالما',
  'طفق',
  'طق',
  'ظل',
  'عاد',
  'عام',
  'عاما',
  'عامة',
  'عدا',
  'عدة',
  'عدد',
  'عدس',
  'عدم',
  'عسى',
  'عشر',
  'عشرة',
  'عل',
  'علق',
  'عليك',
  'عليه',
  'عليها',
  'عما',
  'عندما',
  'عوض',
  'عين',
  'غدا',
  'ف',
  'فان',
  'فلان',
  'فو',
  'فى',
  'فيم',
  'فيما',
  'فيه',
  'فيها',
  'قال',
  'قام',
  'قط',
  'قلما',
  'قوة',
  'كأنما',
  'كأي',
  'كأين',
  'كاد',
  'كخ',
  'كذا',
  'كذلك',
  'كرب',
  'كلا',
  'كلاهما',
  'كلتا',
  'كلم',
  'كلما',
  'كليكما',
  'كليهما',
  'كم',
  'كي',
  'كيت',
  'كيفما',
  'لئن',
  'لات',
  'لاسيما',
  'لدن',
  'لست',
  'لستم',
  'لستما',
  'لستن',
  'لسن',
  'لسنا',
  'لعمر',
  'لقاء',
  'لك',
  'لكم',
  'لكما',
  'لكنما',
  'لكيلا',
  'للامم',
  'لما',
  'لنا',
  'له',
  'لها',
  'لوكالة',
  'لوما',
  'لي',
  'ليسا',
  'ليست',
  'ليستا',
  'ليسوا',
  'ماانفك',
  'مابرح',
  'مادام',
  'ماذا',
  'مازال',
  'مافتئ',
  'مايو',
  'مذ',
  'مساء',
  'معاذ',
  'مقابل',
  'مكانك',
  'مكانكم',
  'مكانكما',
  'مكانكن',
  'مليار',
  'مليون',
  'ممن',
  'منها',
  'مه',
  'مهما',
  'نحو',
  'نخ',
  'نعم',
  'نعما',
  'نفسه',
  'نهاية',
  'ها',
  'هاؤم',
  'هاته',
  'هاتي',
  'هاتين',
  'هاك',
  'هاهنا',
  'هب',
  'هج',
  'هذي',
  'هذين',
  'هكذا',
  'هلا',
  'هلم',
  'هما',
  'هنالك',
  'هيا',
  'هيت',
  'هيهات',
  'و',
  'و6',
  'وا',
  'واحد',
  'واضاف',
  'واضافت',
  'واكد',
  'وان',
  'واها',
  'واوضح',
  'وراءك',
  'وشكان',
  'وفي',
  'وقال',
  'وقالت',
  'وقد',
  'وقف',
  'وكان',
  'وكانت',
  'ولم',
  'ومن',
  'وهو',
  'وهي',
  'وي',
  'ويكأن',
  'يمكن',
  'يوم',
])

export const arabic: LanguageModule = {
  name: 'arabic',
  stemmer: stem,
  stopWords,
  tokenizer: { splitPattern: /[^\u0621-\u064a\u0660-\u0669a-z0-9]+/gi },
}
