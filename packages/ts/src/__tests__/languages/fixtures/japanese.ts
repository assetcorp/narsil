import { japanese } from '../../../languages/japanese'
import { defineLanguageFixture } from './types'

const JA_WIKIPEDIA = "Japanese Wikipedia, article '日本語' (https://ja.wikipedia.org/wiki/日本語)"
const JA_SOSEKI = 'Japanese Wikisource, Natsume Sōseki, 吾輩は猫である (https://ja.wikisource.org/wiki/吾輩は猫である)'
const JA_YOSHINOYA = "Japanese Wikipedia, article '吉野家' (https://ja.wikipedia.org/wiki/吉野家)"

export const japaneseFixture = defineLanguageFixture({
  module: japanese,
  samples: [
    {
      text: '使用人口について正確な統計はないが、日本国内の人口、及び日本国外に住む日本人や日系人、日本がかつて統治した地域の一部住民など、約1億3,000万人以上と考えられている。',
      source: JA_WIKIPEDIA,
    },
    {
      text: '『吾輩は猫である』（わがはいはねこである）は、夏目漱石の長編小説であり、処女小説である。',
      source: JA_SOSEKI,
    },
    {
      text: 'へえアンドレア・デル・サルトがそんな事をいった事があるかい。',
      source: JA_SOSEKI,
    },
    {
      text: '人々の日本語に寄せる関心は、第二次世界大戦後に特に顕著になったといえる。',
      source: JA_WIKIPEDIA,
    },
    {
      text: '日本語（族）の系統については明治以来様々な説が議論されてきたが、いずれも他の語族との同系の証明に至っておらず、不明のままである。',
      source: JA_WIKIPEDIA,
    },
    {
      text: '𠮷野家（よしのや）は、東京都中央区日本橋箱崎町に本社を置く、牛丼を主力商品とする日本の大手外食チェーンストアである。',
      source: JA_YOSHINOYA,
    },
  ],
  indivisible: ['吾輩', '人々', '様々'],
  separates: [
    { text: '吾輩は猫である', tokens: ['吾輩', 'は', '猫', 'であ', 'ある'] },
    { text: 'アンドレア・デル・サルト', tokens: ['アン', 'ンド', 'ドレ', 'レア', 'デル', 'サル', 'ルト'] },
    {
      text: '夏目漱石の長編小説であり',
      tokens: ['夏目', '目漱', '漱石', 'の', '長編', '編小', '小説', 'であ', 'あり'],
    },
    { text: '人々の日本語', tokens: ['人々', 'の', '日本', '本語'] },
    { text: '様々な説', tokens: ['様々', 'な', '説'] },
    { text: '𠮷野家（よしのや）', tokens: ['𠮷野', '野家', 'よし', 'しの', 'のや'] },
  ],
  equivalent: [
    ['ﾆｯﾎﾟﾝ', 'ニッポン'],
    ['ｶﾞｸｾｲ', 'ガクセイ'],
    ['ﾆﾎﾝｺﾞ', 'ニホンゴ'],
    ['ＡＢＣ', 'ABC'],
    ['１９０５', '1905'],
  ],
  retrievable: [
    { query: '猫', text: '『吾輩は猫である』（わがはいはねこである）は、夏目漱石の長編小説であり、処女小説である。' },
    { query: 'デル', text: 'へえアンドレア・デル・サルトがそんな事をいった事があるかい。' },
    { query: '人々', text: '人々の日本語に寄せる関心は、第二次世界大戦後に特に顕著になったといえる。' },
    {
      query: '日本語',
      text: '日本語（族）の系統については明治以来様々な説が議論されてきたが、いずれも他の語族との同系の証明に至っておらず、不明のままである。',
    },
    {
      query: '夏目漱石',
      text: '『吾輩は猫である』（わがはいはねこである）は、夏目漱石の長編小説であり、処女小説である。',
    },
    {
      query: '長編小説',
      text: '『吾輩は猫である』（わがはいはねこである）は、夏目漱石の長編小説であり、処女小説である。',
    },
    {
      query: '𠮷野家',
      text: '𠮷野家（よしのや）は、東京都中央区日本橋箱崎町に本社を置く、牛丼を主力商品とする日本の大手外食チェーンストアである。',
    },
    {
      query: '日系人',
      text: '使用人口について正確な統計はないが、日本国内の人口、及び日本国外に住む日本人や日系人、日本がかつて統治した地域の一部住民など、約1億3,000万人以上と考えられている。',
    },
  ],
})
