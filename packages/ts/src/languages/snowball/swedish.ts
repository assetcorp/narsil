/*
 * Generated from algorithms/swedish.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 5ff576fe6e2b2a68
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['fab', -1],
  ['h', -1],
  ['pak', -1],
  ['rak', -1],
  ['stak', -1],
  ['kom', -1],
  ['iet', -1],
  ['cit', -1],
  ['dit', -1],
  ['alit', -1],
  ['ilit', -1],
  ['mit', -1],
  ['nit', -1],
  ['pit', -1],
  ['rit', -1],
  ['sit', -1],
  ['tit', -1],
  ['uit', -1],
  ['ivit', -1],
  ['kvit', -1],
  ['xit', -1],
]

const a_1: Among[] = [
  ['a', 1],
  ['arna', 1, 1],
  ['erna', 1, 2],
  ['heterna', 1, 1],
  ['orna', 1, 4],
  ['ad', 1],
  ['e', 1],
  ['ade', 1, 1],
  ['ande', 1, 2],
  ['arne', 1, 3],
  ['are', 1, 4],
  ['aste', 1, 5],
  ['en', 1],
  ['anden', 1, 1],
  ['aren', 1, 2],
  ['heten', 1, 3],
  ['ern', 1],
  ['ar', 1],
  ['er', 1],
  ['heter', 1, 1],
  ['or', 1],
  ['s', 2],
  ['as', 1, 1],
  ['arnas', 1, 1],
  ['ernas', 1, 2],
  ['ornas', 1, 3],
  ['es', 1, 5],
  ['ades', 1, 1],
  ['andes', 1, 2],
  ['ens', 1, 8],
  ['arens', 1, 1],
  ['hetens', 1, 2],
  ['erns', 1, 11],
  ['at', 1],
  ['et', 3],
  ['andet', 1, 1],
  ['het', 1, 2],
  ['ast', 1],
]

const a_2: Among[] = [
  ['dd', -1],
  ['gd', -1],
  ['nn', -1],
  ['dt', -1],
  ['gt', -1],
  ['kt', -1],
  ['tt', -1],
]

const a_3: Among[] = [
  ['ig', 1],
  ['lig', 1, 1],
  ['els', 1],
  ['fullt', 3],
  ['\u00F6st', 2],
]

const g_v: number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 24, 0, 32]

const g_s_ending: number[] = [119, 127, 149]

const g_ost_ending: number[] = [173, 58]

export class SwedishStemmer extends BaseStemmer {
  #r_et_condition(): boolean {
    const v_1: number = this.limit - this.c
    if (!this.out_grouping_b(g_v, 97, 246)) return false
    if (!this.in_grouping_b(g_v, 97, 246)) return false
    if (/**@type {boolean}*/ (this.c <= this.limit_backward)) return false
    this.c = this.limit - v_1
    {
      const v_2: number = this.limit - this.c
      lab0: {
        if (this.find_among_b(a_0) === 0) break lab0
        return false
      }
      this.c = this.limit - v_2
    }
    return true
  }

  #stem(): boolean {
    let a: number
    let I_x: number
    let I_p1: number
    const v_1: number = this.c
    lab0: {
      I_p1 = this.limit
      const v_2: number = this.c
      if (this.c + 3 > this.limit) break lab0
      this.c += 3
      I_x = this.c
      this.c = v_2
      if (!this.go_out_grouping(g_v, 97, 246)) break lab0
      this.c++
      if (!this.go_in_grouping(g_v, 97, 246)) break lab0
      this.c++
      I_p1 = this.c
      lab1: {
        if (/**@type {boolean}*/ (I_p1 >= I_x)) break lab1
        I_p1 = I_x
      }
    }
    this.c = v_1
    this.limit_backward = this.c
    this.c = this.limit
    const v_3: number = this.limit - this.c
    lab2: {
      if (this.c < I_p1) break lab2
      const v_4: number = this.limit_backward
      this.limit_backward = I_p1
      this.ket = this.c
      a = this.find_among_b(a_1)
      if (a === 0) {
        this.limit_backward = v_4
        break lab2
      }
      this.bra = this.c
      this.limit_backward = v_4
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          lab3: {
            const v_5: number = this.limit - this.c
            lab4: {
              if (!this.eq_s_b('et')) break lab4
              if (!this.#r_et_condition()) break lab4
              this.bra = this.c
              break lab3
            }
            this.c = this.limit - v_5
            if (!this.in_grouping_b(g_s_ending, 98, 121)) break lab2
          }
          this.slice_del()
          break
        }
        case 3: {
          if (!this.#r_et_condition()) break lab2
          this.slice_del()
          break
        }
      }
    }
    this.c = this.limit - v_3
    const v_6: number = this.limit - this.c
    lab5: {
      if (this.c < I_p1) break lab5
      const v_7: number = this.limit_backward
      this.limit_backward = I_p1
      const v_8: number = this.limit - this.c
      if (this.find_among_b(a_2) === 0) {
        this.limit_backward = v_7
        break lab5
      }
      this.c = this.limit - v_8
      this.ket = this.c
      if (this.c <= this.limit_backward) {
        this.limit_backward = v_7
        break lab5
      }
      this.c--
      this.bra = this.c
      this.slice_del()
      this.limit_backward = v_7
    }
    this.c = this.limit - v_6
    const v_9: number = this.limit - this.c
    lab6: {
      if (this.c < I_p1) break lab6
      const v_10: number = this.limit_backward
      this.limit_backward = I_p1
      this.ket = this.c
      a = this.find_among_b(a_3)
      if (a === 0) {
        this.limit_backward = v_10
        break lab6
      }
      this.bra = this.c
      this.limit_backward = v_10
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          if (!this.in_grouping_b(g_ost_ending, 105, 118)) break lab6
          this.slice_from('\u00F6s')
          break
        }
        case 3: {
          this.slice_from('full')
          break
        }
      }
    }
    this.c = this.limit - v_9
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new SwedishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '5ff576fe6e2b2a68'
