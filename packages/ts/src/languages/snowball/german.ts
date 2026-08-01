/*
 * Generated from algorithms/german.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision ff10b0dd9feeb7cb
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['', 5],
  ['ae', 2, 1],
  ['oe', 3, 2],
  ['qu', -1, 3],
  ['ue', 4, 4],
  ['\u00DF', 1, 5],
]

const a_1: Among[] = [
  ['', 5],
  ['U', 2, 1],
  ['Y', 1, 2],
  ['\u00E4', 3, 3],
  ['\u00F6', 4, 4],
  ['\u00FC', 2, 5],
]

const a_2: Among[] = [
  ['e', 3],
  ['em', 1],
  ['en', 3],
  ['erinnen', 2, 1],
  ['erin', 2],
  ['ln', 5],
  ['ern', 2],
  ['er', 2],
  ['s', 4],
  ['es', 3, 1],
  ['lns', 5, 2],
]

const a_3: Among[] = [
  ['tick', -1],
  ['plan', -1],
  ['geordn', -1],
  ['intern', -1],
  ['tr', -1],
]

const a_4: Among[] = [
  ['en', 1],
  ['er', 1],
  ['et', 3],
  ['st', 2],
  ['est', 1, 1],
]

const a_5: Among[] = [
  ['ig', 1],
  ['lich', 1],
]

const a_6: Among[] = [
  ['end', 1],
  ['ig', 2],
  ['ung', 1],
  ['lich', 3],
  ['isch', 2],
  ['ik', 2],
  ['heit', 3],
  ['keit', 4],
]

const a_7: Among[] = [
  ["'", 1],
  ["'sch", 1],
  ["'s", 1],
]

const g_v: number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32, 8]

const g_et_ending: number[] = [1, 128, 198, 227, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128]

const g_s_ending: number[] = [117, 30, 5]

const g_st_ending: number[] = [117, 30, 4]

export class GermanStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let I_x: number
    let I_p2: number
    let I_p1: number
    const v_1: number = this.c
    {
      const v_2: number = this.c
      while (true) {
        const v_3: number = this.c
        lab1: {
          while (true) {
            const v_4: number = this.c
            lab3: {
              if (!this.in_grouping(g_v, 97, 252)) break lab3
              this.bra = this.c
              lab4: {
                const v_5: number = this.c
                lab5: {
                  if (!this.eq_s('u')) break lab5
                  this.ket = this.c
                  if (!this.in_grouping(g_v, 97, 252)) break lab5
                  this.slice_from('U')
                  break lab4
                }
                this.c = v_5
                if (!this.eq_s('y')) break lab3
                this.ket = this.c
                if (!this.in_grouping(g_v, 97, 252)) break lab3
                this.slice_from('Y')
              }
              this.c = v_4
              break
            }
            this.c = v_4
            if (this.c >= this.limit) break lab1
            this.c++
          }
          continue
        }
        this.c = v_3
        break
      }
      this.c = v_2
      while (true) {
        const v_6: number = this.c
        lab6: {
          this.bra = this.c
          a = this.find_among(a_0)
          this.ket = this.c
          switch (a) {
            case 1: {
              this.slice_from('ss')
              break
            }
            case 2: {
              this.slice_from('\u00E4')
              break
            }
            case 3: {
              this.slice_from('\u00F6')
              break
            }
            case 4: {
              this.slice_from('\u00FC')
              break
            }
            case 5: {
              if (this.c >= this.limit) break lab6
              this.c++
              break
            }
          }
          continue
        }
        this.c = v_6
        break
      }
    }
    this.c = v_1
    const v_7: number = this.c
    lab7: {
      I_p1 = this.limit
      I_p2 = this.limit
      const v_8: number = this.c
      if (this.c + 3 > this.limit) break lab7
      this.c += 3
      I_x = this.c
      this.c = v_8
      if (!this.go_out_grouping(g_v, 97, 252)) break lab7
      this.c++
      if (!this.go_in_grouping(g_v, 97, 252)) break lab7
      this.c++
      I_p1 = this.c
      lab8: {
        if (/**@type {boolean}*/ (I_p1 >= I_x)) break lab8
        I_p1 = I_x
      }
      if (!this.go_out_grouping(g_v, 97, 252)) break lab7
      this.c++
      if (!this.go_in_grouping(g_v, 97, 252)) break lab7
      this.c++
      I_p2 = this.c
    }
    this.c = v_7
    this.limit_backward = this.c
    this.c = this.limit
    {
      const v_9: number = this.limit - this.c
      lab10: {
        this.ket = this.c
        a = this.find_among_b(a_2)
        if (a === 0) break lab10
        this.bra = this.c
        if (/**@type {boolean}*/ (I_p1 > this.c)) break lab10
        switch (a) {
          case 1: {
            lab11: {
              if (!this.eq_s_b('syst')) break lab11
              break lab10
            }
            this.slice_del()
            break
          }
          case 2: {
            this.slice_del()
            break
          }
          case 3: {
            this.slice_del()
            const v_10: number = this.limit - this.c
            lab12: {
              this.ket = this.c
              if (!this.eq_s_b('s')) {
                this.c = this.limit - v_10
                break lab12
              }
              this.bra = this.c
              if (!this.eq_s_b('nis')) {
                this.c = this.limit - v_10
                break lab12
              }
              this.slice_del()
            }
            break
          }
          case 4: {
            if (!this.in_grouping_b(g_s_ending, 98, 116)) break lab10
            this.slice_del()
            break
          }
          case 5: {
            this.slice_from('l')
            break
          }
        }
      }
      this.c = this.limit - v_9
      const v_11: number = this.limit - this.c
      lab13: {
        this.ket = this.c
        a = this.find_among_b(a_4)
        if (a === 0) break lab13
        this.bra = this.c
        if (/**@type {boolean}*/ (I_p1 > this.c)) break lab13
        switch (a) {
          case 1: {
            this.slice_del()
            break
          }
          case 2: {
            if (!this.in_grouping_b(g_st_ending, 98, 116)) break lab13
            if (this.c - 3 < this.limit_backward) break lab13
            this.c -= 3
            this.slice_del()
            break
          }
          case 3: {
            const v_12: number = this.limit - this.c
            if (!this.in_grouping_b(g_et_ending, 85, 228)) break lab13
            this.c = this.limit - v_12
            {
              const v_13: number = this.limit - this.c
              lab14: {
                if (this.find_among_b(a_3) === 0) break lab14
                break lab13
              }
              this.c = this.limit - v_13
            }
            this.slice_del()
            break
          }
        }
      }
      this.c = this.limit - v_11
      const v_14: number = this.limit - this.c
      lab15: {
        this.ket = this.c
        a = this.find_among_b(a_6)
        if (a === 0) break lab15
        this.bra = this.c
        if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
        switch (a) {
          case 1: {
            this.slice_del()
            const v_15: number = this.limit - this.c
            lab16: {
              this.ket = this.c
              if (!this.eq_s_b('ig')) {
                this.c = this.limit - v_15
                break lab16
              }
              this.bra = this.c
              lab17: {
                if (!this.eq_s_b('e')) break lab17
                this.c = this.limit - v_15
                break lab16
              }
              if (/**@type {boolean}*/ (I_p2 > this.c)) {
                this.c = this.limit - v_15
                break lab16
              }
              this.slice_del()
            }
            break
          }
          case 2: {
            lab18: {
              if (!this.eq_s_b('e')) break lab18
              break lab15
            }
            this.slice_del()
            break
          }
          case 3: {
            this.slice_del()
            const v_16: number = this.limit - this.c
            lab19: {
              this.ket = this.c
              lab20: {
                lab21: {
                  if (!this.eq_s_b('er')) break lab21
                  break lab20
                }
                if (!this.eq_s_b('en')) {
                  this.c = this.limit - v_16
                  break lab19
                }
              }
              this.bra = this.c
              if (/**@type {boolean}*/ (I_p1 > this.c)) {
                this.c = this.limit - v_16
                break lab19
              }
              this.slice_del()
            }
            break
          }
          case 4: {
            this.slice_del()
            const v_17: number = this.limit - this.c
            lab22: {
              this.ket = this.c
              if (this.find_among_b(a_5) === 0) {
                this.c = this.limit - v_17
                break lab22
              }
              this.bra = this.c
              if (/**@type {boolean}*/ (I_p2 > this.c)) {
                this.c = this.limit - v_17
                break lab22
              }
              this.slice_del()
            }
            break
          }
        }
      }
      this.c = this.limit - v_14
      const v_18: number = this.limit - this.c
      lab23: {
        this.ket = this.c
        if (this.find_among_b(a_7) === 0) break lab23
        this.bra = this.c
        if (this.c <= this.limit_backward) break lab23
        this.c--
        if (/**@type {boolean}*/ (this.c <= this.limit_backward)) break lab23
        this.slice_del()
      }
      this.c = this.limit - v_18
    }
    this.c = this.limit_backward
    const v_19: number = this.c
    while (true) {
      const v_20: number = this.c
      lab25: {
        this.bra = this.c
        a = this.find_among(a_1)
        this.ket = this.c
        switch (a) {
          case 1: {
            this.slice_from('y')
            break
          }
          case 2: {
            this.slice_from('u')
            break
          }
          case 3: {
            this.slice_from('a')
            break
          }
          case 4: {
            this.slice_from('o')
            break
          }
          case 5: {
            if (this.c >= this.limit) break lab25
            this.c++
            break
          }
        }
        continue
      }
      this.c = v_20
      break
    }
    this.c = v_19
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new GermanStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'ff10b0dd9feeb7cb'
