/*
 * Generated from algorithms/czech.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 48b013a41884beb9
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['c', 1],
  ['nc', -1, 1],
  ['\u00EDnc', 2, 1],
  ['avc', -1, 3],
  ['ovc', -1, 4],
]

const as_0: string[] = ['k', '\u00EDnk']

const a_1: Among[] = [
  ['c', 1],
  ['nc', -1, 1],
  ['\u00EDnc', 2, 1],
  ['avc', -1, 3],
  ['ovc', -1, 4],
  ['\u010Dt', 3],
  ['\u0161t', 4],
  ['de\u0161t', -1, 1],
  ['le\u0161t', -1, 2],
  ['i\u0161t', -1, 3],
  ['pou\u0161t', -1, 4],
  ['\u00E1\u0161t', -1, 5],
  ['\u00ED\u0161t', -1, 6],
]

const as_1: string[] = ['k', '\u00EDnk', 'ck', 'sk']

const a_2: Among[] = [
  ['in', 2],
  ['ov', 1],
  ['\u016Fv', 1],
]

const a_3: Among[] = [
  ['', 2],
  ['l', 1, 1],
  ['tl', 2, 1],
  ['s', 1, 3],
  ['es', 2, 1],
  ['\u010D', 1, 5],
  ['e\u010D', 2, 1],
  ['\u0159', 1, 7],
  ['\u017E', 1, 8],
]

const as_3: string[] = ['', 'et']

const a_4: Among[] = [
  ['obl', -1],
  ['sn', -1],
  ['dot', -1],
]

const a_5: Among[] = [
  ['uc', -1],
  ['h', -1],
  ['ok', -1],
  ['kar', -1],
  ['\u010D', -1],
]

const a_6: Among[] = [
  ['a', 1],
  ['ama', 1, 1],
  ['ata', 1, 2],
  ['eb', 4],
  ['ec', 5],
  ['e', 2],
  ['ete', 3, 1],
  ['\u011Bte', 1, 2],
  ['ech', 2],
  ['atech', 1, 1],
  ['\u00E1ch', 1],
  ['\u00EDch', 12],
  ['\u00FDch', 1],
  ['i', 12],
  ['mi', 1, 1],
  ['ami', 1, 1],
  ['emi', 2, 2],
  ['\u00EDmi', 12, 3],
  ['\u00FDmi', 1, 4],
  ['\u011Bmi', 1, 5],
  ['\u0165mi', 11, 6],
  ['eti', 3, 8],
  ['\u011Bti', 1, 9],
  ['ovi', 1, 10],
  ['ek', 6],
  ['\u011Bk', 7],
  ['em', 2],
  ['etem', 3, 1],
  ['\u011Btem', 1, 2],
  ['\u00E1m', 1],
  ['\u00E9m', 1],
  ['\u00EDm', 12],
  ['\u00FDm', 1],
  ['\u011Bm', 1],
  ['\u016Fm', 1],
  ['at\u016Fm', 1, 1],
  ['o', 1],
  ['\u00E9ho', 1, 1],
  ['\u00EDho', 12, 2],
  ['us', 1],
  ['at', 1],
  ['et', 9],
  ['u', 1],
  ['\u00E9mu', 1, 1],
  ['\u00EDmu', 12, 2],
  ['ou', 1, 3],
  ['ev', 10],
  ['y', 1],
  ['aty', 1, 1],
  ['\u00E1', 1],
  ['\u00E9', 1],
  ['ov\u00E9', 1, 1],
  ['\u00ED', 12],
  ['\u00FD', 1],
  ['\u011B', 1],
  ['e\u0148', 8],
  ['\u0165', 11],
  ['\u016F', 1],
]

const g_v: number[] = [
  17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 18, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64,
]

const g_v_or_syllabic_c: number[] = [
  17, 73, 18, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 18, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64,
]

const g_ev_ending: number[] = [73, 20, 4]

const g_env_ending: number[] = [
  71, 66, 23, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 16,
]

export class CzechStemmer extends BaseStemmer {
  #r_palatalise_e(): boolean {
    let a: number
    this.ket = this.c
    a = this.find_among_b(a_0)
    if (a === 0) return false
    this.bra = this.c
    if (a > 0) {
      this.slice_from(as_0[a - 1])
    }
    return true
  }

  #r_palatalise_i(): boolean {
    let a: number
    this.ket = this.c
    a = this.find_among_b(a_1)
    if (a === 0) return false
    this.bra = this.c
    if (a > 0) {
      this.slice_from(as_1[a - 1])
    }
    return true
  }

  #stem(): boolean {
    let a: number
    let I_x: number
    let I_p1: number
    const v_1: number = this.c
    if (this.c + 3 > this.limit) return false
    this.c += 3
    I_x = this.c
    this.c = v_1
    I_p1 = this.limit
    const v_2: number = this.c
    lab0: {
      lab1: {
        lab2: {
          if (!this.in_grouping(g_v, 97, 367)) break lab2
          break lab1
        }
        if (this.c >= this.limit) break lab0
        this.c++
        if (!this.go_out_grouping(g_v_or_syllabic_c, 97, 367)) break lab0
        this.c++
      }
      if (!this.go_in_grouping(g_v, 97, 367)) break lab0
      this.c++
      I_p1 = this.c
      lab3: {
        if (/**@type {boolean}*/ (I_p1 >= I_x)) break lab3
        I_p1 = I_x
      }
    }
    this.c = v_2
    this.limit_backward = this.c
    this.c = this.limit
    const v_3: number = this.limit - this.c
    lab4: {
      if (this.c < I_p1) break lab4
      const v_4: number = this.limit_backward
      this.limit_backward = I_p1
      this.ket = this.c
      a = this.find_among_b(a_6)
      if (a === 0) {
        this.limit_backward = v_4
        break lab4
      }
      this.bra = this.c
      this.limit_backward = v_4
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          this.slice_del()
          const v_5: number = this.limit - this.c
          lab5: {
            if (!this.#r_palatalise_e()) {
              this.c = this.limit - v_5
              break lab5
            }
          }
          break
        }
        case 3: {
          a = this.find_among_b(a_3)
          this.slice_from(as_3[a - 1])
          break
        }
        case 4: {
          const v_6: number = this.limit - this.c
          if (!this.out_grouping_b(g_v, 97, 367)) break lab4
          this.c = this.limit - v_6
          lab6: {
            if (!this.eq_s_b('t\u0159')) break lab6
            break lab4
          }
          this.slice_from('b')
          break
        }
        case 5: {
          const v_7: number = this.limit - this.c
          if (!this.out_grouping_b(g_v, 97, 367)) break lab4
          this.c = this.limit - v_7
          this.slice_del()
          this.insert(this.c, this.c, 'c')
          const v_8: number = this.limit - this.c
          lab7: {
            if (!this.#r_palatalise_e()) {
              this.c = this.limit - v_8
              break lab7
            }
          }
          break
        }
        case 6: {
          const v_9: number = this.limit - this.c
          if (!this.out_grouping_b(g_v, 97, 367)) break lab4
          this.c = this.limit - v_9
          {
            const v_10: number = this.limit - this.c
            lab8: {
              if (this.find_among_b(a_4) === 0) break lab8
              break lab4
            }
            this.c = this.limit - v_10
          }
          this.slice_from('k')
          break
        }
        case 7: {
          if (!this.eq_s_b('n')) break lab4
          this.bra = this.c
          this.slice_from('\u0148k')
          break
        }
        case 8: {
          const v_11: number = this.limit - this.c
          if (!this.in_grouping_b(g_env_ending, 98, 382)) break lab4
          this.c = this.limit - v_11
          this.slice_from('n')
          break
        }
        case 9: {
          if (this.find_among_b(a_5) === 0) break lab4
          this.slice_from('t')
          break
        }
        case 10: {
          if (!this.in_grouping_b(g_ev_ending, 104, 122)) break lab4
          this.slice_from('v')
          break
        }
        case 11: {
          this.slice_from('t')
          break
        }
        case 12: {
          this.slice_del()
          const v_12: number = this.limit - this.c
          lab9: {
            if (!this.#r_palatalise_i()) {
              this.c = this.limit - v_12
              break lab9
            }
          }
          break
        }
      }
    }
    this.c = this.limit - v_3
    const v_13: number = this.limit - this.c
    lab10: {
      this.ket = this.c
      a = this.find_among_b(a_2)
      if (a === 0) break lab10
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab10
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          this.slice_del()
          const v_14: number = this.limit - this.c
          lab11: {
            if (!this.#r_palatalise_i()) {
              this.c = this.limit - v_14
              break lab11
            }
          }
          break
        }
      }
    }
    this.c = this.limit - v_13
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new CzechStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '48b013a41884beb9'
