import { bengali } from '../../../languages/bengali'
import { defineLanguageFixture } from './types'

const BN_LANGUAGE = "Bengali Wikipedia, article 'বাংলা ভাষা' (https://bn.wikipedia.org/wiki/বাংলা_ভাষা)"

export const bengaliFixture = defineLanguageFixture({
  module: bengali,
  samples: [
    {
      text: 'বাংলা ভাষা একটি ধ্রুপদি ইন্দো-আর্য ভাষা, যা দক্ষিণ এশিয়ার বাঙালি জাতির প্রধান কথ্য ও লেখ্য ভাষা।',
      source: BN_LANGUAGE,
    },
    {
      text: 'বাংলা ভাষার কবি রবীন্দ্রনাথ ঠাকুর তার গীতাঞ্জলি কাব্যের জন্য ১৯১৩ সালে সাহিত্যে নোবেল পুরস্কার লাভ করেন।',
      source: BN_LANGUAGE,
    },
  ],
  indivisible: ['বাংলা', 'এশিয়ার', 'রবীন্দ্রনাথ', 'গীতাঞ্জলি'],
  separates: [
    {
      text: 'দক্ষিণ এশিয়ার বাঙালি জাতির',
      tokens: ['দক্ষিণ', 'এশিয়ার', 'বাঙালি', 'জাতির'],
    },
    {
      text: 'সাহিত্যে নোবেল পুরস্কার লাভ করেন',
      tokens: ['সাহিত্যে', 'নোবেল', 'পুরস্কার', 'লাভ', 'করেন'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ধ্রুপদি',
      text: 'বাংলা ভাষা একটি ধ্রুপদি ইন্দো-আর্য ভাষা, যা দক্ষিণ এশিয়ার বাঙালি জাতির প্রধান কথ্য ও লেখ্য ভাষা।',
    },
    {
      query: 'গীতাঞ্জলি',
      text: 'বাংলা ভাষার কবি রবীন্দ্রনাথ ঠাকুর তার গীতাঞ্জলি কাব্যের জন্য ১৯১৩ সালে সাহিত্যে নোবেল পুরস্কার লাভ করেন।',
    },
  ],
})
