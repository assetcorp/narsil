import { korean } from '../../../languages/korean'
import { defineLanguageFixture } from './types'

const KO_LANGUAGE = "Korean Wikipedia, article '한국어' (https://ko.wikipedia.org/wiki/한국어)"

export const koreanFixture = defineLanguageFixture({
  module: korean,
  samples: [
    {
      text: '한국어(韓國語)는 대한민국과 조선민주주의인민공화국의 공용어이다.',
      source: KO_LANGUAGE,
    },
    {
      text: '한반도를 비롯하여 세계 여러 지역에 거주하는 한민족 인구가 한국어를 모어로 사용한다.',
      source: KO_LANGUAGE,
    },
  ],
  indivisible: ['세계', '인구', '한국', '국어'],
  separates: [
    {
      text: '한국어를 모어로 사용한다',
      tokens: ['한국', '국어', '어를', '모어', '어로', '사용', '용한', '한다'],
    },
    {
      text: '한국어(韓國語)는',
      tokens: ['한국', '국어', '韓國', '國語', '는'],
    },
  ],
  equivalent: [['２０１６', '2016']],
  retrievable: [
    {
      query: '한국어',
      text: '한국어(韓國語)는 대한민국과 조선민주주의인민공화국의 공용어이다.',
    },
    {
      query: '한민족',
      text: '한반도를 비롯하여 세계 여러 지역에 거주하는 한민족 인구가 한국어를 모어로 사용한다.',
    },
  ],
})
