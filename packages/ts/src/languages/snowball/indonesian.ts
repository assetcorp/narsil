/*
 * Generated from algorithms/indonesian.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision c0b2b853663a1396
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['kah', 1],
  ['lah', 1],
  ['pun', 1],
]

const a_1: Among[] = [
  ['nya', 1],
  ['ku', 1],
  ['mu', 1],
]

const a_2: Among[] = [
  ['i', 2],
  ['an', 1],
]

const a_3: Among[] = [
  ['di', 1],
  ['ke', 3],
  ['me', 1],
  ['mem', 5, 1],
  ['men', 2, 2],
  ['meng', 1, 1],
  ['pem', 6],
  ['pen', 4],
  ['peng', 3, 1],
  ['ter', 1],
]

const a_4: Among[] = [
  ['be', 2],
  ['pe', 1],
]

const g_vowel: number[] = [17, 65, 16]

export class IndonesianStemmer extends BaseStemmer {
  #I_prefix /**@type {number}*/ = 0
  #I_measure /**@type {number}*/ = 0

  #r_remove_suffix(): boolean {
    let a: number
    this.ket = this.c
    a = this.find_among_b(a_2)
    if (a === 0) return false
    this.bra = this.c
    switch (a) {
      case 1: {
        lab0: {
          const v_1: number = this.limit - this.c
          lab1: {
            if (/**@type {boolean}*/ (this.#I_prefix === 3)) break lab1
            if (/**@type {boolean}*/ (this.#I_prefix === 2)) break lab1
            if (!this.eq_s_b('k')) break lab1
            this.bra = this.c
            break lab0
          }
          this.c = this.limit - v_1
          if (/**@type {boolean}*/ (this.#I_prefix === 1)) return false
        }
        break
      }
      case 2: {
        if (/**@type {boolean}*/ (this.#I_prefix > 2)) return false
        lab2: {
          if (!this.eq_s_b('s')) break lab2
          return false
        }
        break
      }
    }
    this.slice_del()
    --this.#I_measure
    return true
  }

  #r_remove_second_order_prefix(): boolean {
    let a: number
    this.bra = this.c
    a = this.find_among(a_4)
    if (a === 0) return false
    switch (a) {
      case 1: {
        lab0: {
          const v_1: number = this.c
          lab1: {
            if (!this.eq_s('r')) break lab1
            this.ket = this.c
            this.#I_prefix = 2
            break lab0
          }
          this.c = v_1
          lab2: {
            if (!this.eq_s('l')) break lab2
            this.ket = this.c
            if (!this.eq_s('ajar')) break lab2
            break lab0
          }
          this.c = v_1
          this.ket = this.c
          this.#I_prefix = 2
        }
        break
      }
      case 2: {
        lab3: {
          const v_2: number = this.c
          lab4: {
            if (!this.eq_s('r')) break lab4
            this.ket = this.c
            break lab3
          }
          this.c = v_2
          lab5: {
            if (!this.eq_s('l')) break lab5
            this.ket = this.c
            if (!this.eq_s('ajar')) break lab5
            break lab3
          }
          this.c = v_2
          this.ket = this.c
          if (!this.out_grouping(g_vowel, 97, 117)) return false
          if (!this.eq_s('er')) return false
        }
        this.#I_prefix = 4
        break
      }
    }
    --this.#I_measure
    this.slice_del()
    return true
  }

  #stem(): boolean {
    let a: number
    this.#I_measure = 0
    const v_1: number = this.c
    while (true) {
      const v_2: number = this.c
      lab1: {
        if (!this.go_out_grouping(g_vowel, 97, 117)) break lab1
        this.c++
        ++this.#I_measure
        continue
      }
      this.c = v_2
      break
    }
    this.c = v_1
    if (/**@type {boolean}*/ (this.#I_measure < 3)) return false
    this.#I_prefix = 0
    this.limit_backward = this.c
    this.c = this.limit
    const v_3: number = this.limit - this.c
    lab2: {
      this.ket = this.c
      if (this.find_among_b(a_0) === 0) break lab2
      this.bra = this.c
      this.slice_del()
      --this.#I_measure
    }
    this.c = this.limit - v_3
    if (/**@type {boolean}*/ (this.#I_measure < 3)) return false
    const v_4: number = this.limit - this.c
    lab3: {
      this.ket = this.c
      if (this.find_among_b(a_1) === 0) break lab3
      this.bra = this.c
      this.slice_del()
      --this.#I_measure
    }
    this.c = this.limit - v_4
    this.c = this.limit_backward
    if (/**@type {boolean}*/ (this.#I_measure < 3)) return false
    lab4: {
      const v_5: number = this.c
      lab5: {
        const v_6: number = this.c
        this.bra = this.c
        a = this.find_among(a_3)
        if (a === 0) break lab5
        this.ket = this.c
        switch (a) {
          case 1: {
            this.slice_del()
            this.#I_prefix = 1
            --this.#I_measure
            break
          }
          case 2: {
            lab6: {
              const v_7: number = this.c
              lab7: {
                if (!this.eq_s('y')) break lab7
                const v_8: number = this.c
                if (!this.in_grouping(g_vowel, 97, 117)) break lab7
                this.c = v_8
                this.ket = this.c
                this.slice_from('s')
                this.#I_prefix = 1
                --this.#I_measure
                break lab6
              }
              this.c = v_7
              this.slice_del()
              this.#I_prefix = 1
              --this.#I_measure
            }
            break
          }
          case 3: {
            this.slice_del()
            this.#I_prefix = 3
            --this.#I_measure
            break
          }
          case 4: {
            lab8: {
              const v_9: number = this.c
              lab9: {
                if (!this.eq_s('y')) break lab9
                const v_10: number = this.c
                if (!this.in_grouping(g_vowel, 97, 117)) break lab9
                this.c = v_10
                this.ket = this.c
                this.slice_from('s')
                this.#I_prefix = 3
                --this.#I_measure
                break lab8
              }
              this.c = v_9
              this.slice_del()
              this.#I_prefix = 3
              --this.#I_measure
            }
            break
          }
          case 5: {
            this.#I_prefix = 1
            --this.#I_measure
            lab10: {
              const v_11: number = this.c
              lab11: {
                const v_12: number = this.c
                if (!this.in_grouping(g_vowel, 97, 117)) break lab11
                this.c = v_12
                this.slice_from('p')
                break lab10
              }
              this.c = v_11
              this.slice_del()
            }
            break
          }
          case 6: {
            this.#I_prefix = 3
            --this.#I_measure
            lab12: {
              const v_13: number = this.c
              lab13: {
                const v_14: number = this.c
                if (!this.in_grouping(g_vowel, 97, 117)) break lab13
                this.c = v_14
                this.slice_from('p')
                break lab12
              }
              this.c = v_13
              this.slice_del()
            }
            break
          }
        }
        const v_15: number = this.c
        lab14: {
          const v_16: number = this.c
          if (/**@type {boolean}*/ (this.#I_measure < 3)) break lab14
          this.limit_backward = this.c
          this.c = this.limit
          if (!this.#r_remove_suffix()) break lab14
          this.c = this.limit_backward
          this.c = v_16
          if (/**@type {boolean}*/ (this.#I_measure < 3)) break lab14
          if (!this.#r_remove_second_order_prefix()) break lab14
        }
        this.c = v_15
        this.c = v_6
        break lab4
      }
      this.c = v_5
      const v_17: number = this.c
      this.#r_remove_second_order_prefix()
      this.c = v_17
      const v_18: number = this.c
      lab15: {
        if (/**@type {boolean}*/ (this.#I_measure < 3)) break lab15
        this.limit_backward = this.c
        this.c = this.limit
        if (!this.#r_remove_suffix()) break lab15
        this.c = this.limit_backward
      }
      this.c = v_18
    }
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new IndonesianStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'c0b2b853663a1396'
