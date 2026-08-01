/*
 * Generated from algorithms/polish.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 373ece41a2c5684b
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['by\u015Bcie', 1],
  ['bym', 1],
  ['by', 1],
  ['by\u015Bmy', 1],
  ['by\u015B', 1],
]

const a_1: Among[] = [
  ['\u0105c', 1],
  ['aj\u0105c', 1, 1],
  ['sz\u0105c', 2, 2],
  ['sz', 1],
  ['iejsz', 1, 1],
]

const as_1: string[] = ['', 's']

const a_2: Among[] = [
  ['a', 1, 0, 1],
  ['\u0105ca', 1, 1],
  ['aj\u0105ca', 1, 1],
  ['sz\u0105ca', 2, 2],
  ['ia', 1, 4, 1],
  ['sza', 1, 5],
  ['iejsza', 1, 1],
  ['a\u0142a', 1, 7],
  ['ia\u0142a', 1, 1],
  ['i\u0142a', 1, 9],
  ['\u0105c', 1],
  ['aj\u0105c', 1, 1],
  ['e', 1, 0, 1],
  ['\u0105ce', 1, 1],
  ['aj\u0105ce', 1, 1],
  ['sz\u0105ce', 2, 2],
  ['ie', 1, 4, 1],
  ['cie', 1, 1],
  ['acie', 1, 1],
  ['ecie', 1, 2],
  ['icie', 1, 3],
  ['ajcie', 1, 4],
  ['li\u015Bcie', 4, 5],
  ['ali\u015Bcie', 1, 1],
  ['ieli\u015Bcie', 1, 2],
  ['ili\u015Bcie', 1, 3],
  ['\u0142y\u015Bcie', 4, 9],
  ['a\u0142y\u015Bcie', 1, 1],
  ['ia\u0142y\u015Bcie', 1, 1],
  ['i\u0142y\u015Bcie', 1, 3],
  ['sze', 1, 18],
  ['iejsze', 1, 1],
  ['ach', 1, 0, 1],
  ['iach', 1, 1, 1],
  ['ich', 5],
  ['ych', 5],
  ['i', 1, 0, 1],
  ['ali', 1, 1],
  ['ieli', 1, 2],
  ['ili', 1, 3],
  ['ami', 1, 4, 1],
  ['iami', 1, 1, 1],
  ['imi', 5, 6],
  ['ymi', 5, 7],
  ['owi', 1, 8, 1],
  ['iowi', 1, 1, 1],
  ['aj', 1],
  ['ej', 5],
  ['iej', 5, 1],
  ['am', 1],
  ['a\u0142am', 1, 1],
  ['ia\u0142am', 1, 1],
  ['i\u0142am', 1, 3],
  ['em', 1, 0, 1],
  ['iem', 1, 1, 1],
  ['a\u0142em', 1, 2],
  ['ia\u0142em', 1, 1],
  ['i\u0142em', 1, 4],
  ['im', 5],
  ['om', 1, 0, 1],
  ['iom', 1, 1, 1],
  ['ym', 5],
  ['o', 1, 0, 1],
  ['ego', 5, 1],
  ['iego', 5, 1],
  ['a\u0142o', 1, 3],
  ['ia\u0142o', 1, 1],
  ['i\u0142o', 1, 5],
  ['u', 1, 0, 1],
  ['iu', 1, 1, 1],
  ['emu', 5, 2],
  ['iemu', 5, 1],
  ['\u00F3w', 1, 0, 1],
  ['y', 5],
  ['amy', 1, 1],
  ['emy', 1, 2],
  ['imy', 1, 3],
  ['li\u015Bmy', 4, 4],
  ['ali\u015Bmy', 1, 1],
  ['ieli\u015Bmy', 1, 2],
  ['ili\u015Bmy', 1, 3],
  ['\u0142y\u015Bmy', 4, 8],
  ['a\u0142y\u015Bmy', 1, 1],
  ['ia\u0142y\u015Bmy', 1, 1],
  ['i\u0142y\u015Bmy', 1, 3],
  ['a\u0142y', 1, 12],
  ['ia\u0142y', 1, 1],
  ['i\u0142y', 1, 14],
  ['asz', 1],
  ['esz', 1],
  ['isz', 1],
  ['\u0105', 1, 0, 1],
  ['\u0105c\u0105', 1, 1],
  ['aj\u0105c\u0105', 1, 1],
  ['sz\u0105c\u0105', 2, 2],
  ['i\u0105', 1, 4, 1],
  ['aj\u0105', 1, 5],
  ['sz\u0105', 3, 6],
  ['iejsz\u0105', 1, 1],
  ['a\u0107', 1],
  ['ie\u0107', 1],
  ['i\u0107', 1],
  ['\u0105\u0107', 1],
  ['a\u015B\u0107', 1],
  ['e\u015B\u0107', 1],
  ['\u0119', 1],
  ['sz\u0119', 2, 1],
  ['a\u0142', 1],
  ['ia\u0142', 1, 1],
  ['i\u0142', 1],
  ['\u0142a\u015B', 4],
  ['a\u0142a\u015B', 1, 1],
  ['ia\u0142a\u015B', 1, 1],
  ['i\u0142a\u015B', 1, 3],
  ['\u0142e\u015B', 4],
  ['a\u0142e\u015B', 1, 1],
  ['ia\u0142e\u015B', 1, 1],
  ['i\u0142e\u015B', 1, 3],
]

const a_3: Among[] = [
  ['\u0107', 1],
  ['\u0144', 2],
  ['\u015B', 3],
  ['\u017A', 4],
]

const as_3: string[] = ['c', 'n', 's', 'z']

const g_v: number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 16, 0, 0, 1]

export class PolishStemmer extends BaseStemmer {
  #I_p1 /**@type {number}*/ = 0

  #r_R1(): boolean {
    return this.#I_p1 <= this.c
  }

  #stem(): boolean {
    let a: number
    const v_1: number = this.c
    lab0: {
      this.#I_p1 = this.limit
      if (!this.go_out_grouping(g_v, 97, 281)) break lab0
      this.c++
      if (!this.go_in_grouping(g_v, 97, 281)) break lab0
      this.c++
      this.#I_p1 = this.c
    }
    this.c = v_1
    lab1: {
      const v_2: number = this.c
      lab2: {
        if (this.c + 2 > this.limit) break lab2
        this.c += 2
        this.limit_backward = this.c
        this.c = this.limit
        const v_3: number = this.limit - this.c
        lab3: {
          if (this.c < this.#I_p1) break lab3
          const v_4: number = this.limit_backward
          this.limit_backward = this.#I_p1
          this.ket = this.c
          if (this.find_among_b(a_0) === 0) {
            this.limit_backward = v_4
            break lab3
          }
          this.bra = this.c
          this.limit_backward = v_4
          this.slice_del()
        }
        this.c = this.limit - v_3
        this.ket = this.c
        a = this.find_among_b(a_2, this.#r_R1)
        if (a === 0) break lab2
        this.bra = this.c
        switch (a) {
          case 1: {
            this.slice_del()
            break
          }
          case 2: {
            this.slice_from('s')
            break
          }
          case 3: {
            lab4: {
              const v_5: number = this.limit - this.c
              lab5: {
                if (/**@type {boolean}*/ (this.#I_p1 > this.c)) break lab5
                this.slice_del()
                break lab4
              }
              this.c = this.limit - v_5
              this.slice_from('s')
            }
            break
          }
          case 4: {
            this.slice_from('\u0142')
            break
          }
          case 5: {
            this.slice_del()
            const v_6: number = this.limit - this.c
            lab6: {
              this.ket = this.c
              a = this.find_among_b(a_1)
              if (a === 0) {
                this.c = this.limit - v_6
                break lab6
              }
              this.bra = this.c
              this.slice_from(as_1[a - 1])
            }
            break
          }
        }
        const v_7: number = this.limit - this.c
        lab7: {
          this.ket = this.c
          if (!this.eq_s_b("'")) {
            this.c = this.limit - v_7
            break lab7
          }
          this.bra = this.c
          this.slice_del()
        }
        this.c = this.limit_backward
        break lab1
      }
      this.c = v_2
      this.limit_backward = this.c
      this.c = this.limit
      this.ket = this.c
      a = this.find_among_b(a_3)
      if (a === 0) return false
      this.bra = this.c
      if (/**@type {boolean}*/ (this.c <= this.limit_backward)) return false
      this.slice_from(as_3[a - 1])
      this.c = this.limit_backward
    }
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new PolishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '373ece41a2c5684b'
