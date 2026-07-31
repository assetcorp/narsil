import { thai } from '../../../languages/thai'
import { defineLanguageFixture } from './types'

const TH_LANGUAGE = "Thai Wikipedia, article 'ภาษาไทย' (https://th.wikipedia.org/wiki/ภาษาไทย)"
const TH_COUNTRY = "Thai Wikipedia, article 'ประเทศไทย' (https://th.wikipedia.org/wiki/ประเทศไทย)"

export const thaiFixture = defineLanguageFixture({
  module: thai,
  samples: [
    {
      text: 'ภาษาไทย หรือ ภาษาไทยกลาง เป็นภาษาในกลุ่มภาษาไท',
      source: TH_LANGUAGE,
    },
    {
      text: 'ประเทศไทย หรือชื่อทางการว่า ราชอาณาจักรไทย เดิมเรียกว่า สยาม',
      source: TH_COUNTRY,
    },
  ],
  indivisible: ['ไท', 'ใน', 'ว่า'],
  separates: [
    {
      text: 'ภาษาไทย',
      tokens: ['ภา', 'าษ', 'ษา', 'าไ', 'ไท', 'ทย'],
    },
    {
      text: 'ราชอาณาจักรไทย',
      tokens: ['รา', 'าช', 'ชอ', 'อา', 'าณ', 'ณา', 'าจั', 'จัก', 'กร', 'รไ', 'ไท', 'ทย'],
    },
  ],
  equivalent: [],
  retrievable: [
    {
      query: 'ราชอาณาจักร',
      text: 'ประเทศไทย หรือชื่อทางการว่า ราชอาณาจักรไทย เดิมเรียกว่า สยาม',
    },
    {
      query: 'กลุ่ม',
      text: 'ภาษาไทย หรือ ภาษาไทยกลาง เป็นภาษาในกลุ่มภาษาไท',
    },
  ],
})
