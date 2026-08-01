/*
 * Generated from algorithms/english.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision ebae3448ae674b59
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['arsen', -1],
  ['commun', -1],
  ['emerg', -1],
  ['gener', -1],
  ['inter', -1],
  ['later', -1],
  ['organ', -1],
  ['past', -1],
  ['univers', -1],
]

const a_1: Among[] = [
  ["'", 1],
  ["'s'", 1, 1],
  ["'s", 1],
]

const a_2: Among[] = [
  ['ied', 2],
  ['s', 3],
  ['ies', 2, 1],
  ['sses', 1, 2],
  ['ss', -1, 3],
  ['us', -1, 4],
]

const a_3: Among[] = [
  ['succ', 1],
  ['proc', 1],
  ['exc', 1],
]

const a_4: Among[] = [
  ['even', 2],
  ['cann', 2],
  ['inn', 2],
  ['earr', 2],
  ['herr', 2],
  ['out', 2],
  ['y', 1],
]

const a_5: Among[] = [
  ['', -1],
  ['ed', 2, 1],
  ['eed', 1, 1],
  ['ing', 3, 3],
  ['edly', 2, 4],
  ['eedly', 1, 1],
  ['ingly', 2, 6],
]

const a_6: Among[] = [
  ['', 3],
  ['bb', 2, 1],
  ['dd', 2, 2],
  ['ff', 2, 3],
  ['gg', 2, 4],
  ['bl', 1, 5],
  ['mm', 2, 6],
  ['nn', 2, 7],
  ['pp', 2, 8],
  ['rr', 2, 9],
  ['at', 1, 10],
  ['tt', 2, 11],
  ['iz', 1, 12],
]

const a_7: Among[] = [
  ['anci', 3],
  ['enci', 2],
  ['ogi', 14],
  ['li', 16],
  ['bli', 12, 1],
  ['abli', 4, 1],
  ['alli', 8, 3],
  ['fulli', 9, 4],
  ['lessli', 15, 5],
  ['ousli', 10, 6],
  ['entli', 5, 7],
  ['aliti', 8],
  ['biliti', 12],
  ['iviti', 11],
  ['tional', 1],
  ['ational', 7, 1],
  ['alism', 8],
  ['ation', 7],
  ['ization', 6, 1],
  ['izer', 6],
  ['ator', 7],
  ['iveness', 11],
  ['fulness', 9],
  ['ousness', 10],
  ['ogist', 13],
]

const a_8: Among[] = [
  ['icate', 4],
  ['ative', 6],
  ['alize', 3],
  ['iciti', 4],
  ['ical', 4],
  ['tional', 1],
  ['ational', 2, 1],
  ['ful', 5],
  ['ness', 5],
]

const a_9: Among[] = [
  ['ic', 1],
  ['ance', 1],
  ['ence', 1],
  ['able', 1],
  ['ible', 1],
  ['ate', 1],
  ['ive', 1],
  ['ize', 1],
  ['iti', 1],
  ['al', 1],
  ['ism', 1],
  ['ion', 2],
  ['er', 1],
  ['ous', 1],
  ['ant', 1],
  ['ent', 1],
  ['ment', 1, 1],
  ['ement', 1, 1],
]

const a_10: Among[] = [
  ['e', 1],
  ['l', 2],
]

const a_11: Among[] = [
  ['andes', -1],
  ['atlas', -1],
  ['bias', -1],
  ['cosmos', -1],
  ['early', 6],
  ['gently', 4],
  ['howe', -1],
  ['idly', 3],
  ['news', -1],
  ['only', 7],
  ['singly', 8],
  ['skies', 2],
  ['skis', 1],
  ['sky', -1],
  ['ugly', 5],
]

const as_11: string[] = ['ski', 'sky', 'idl', 'gentl', 'ugli', 'earli', 'onli', 'singl']

const g_aeo: number[] = [17, 64]

const g_v: number[] = [17, 65, 16, 1]

const g_v_WXY: number[] = [1, 17, 65, 208, 1]

const g_valid_LI: number[] = [55, 141, 2]

export class EnglishStemmer extends BaseStemmer {
  #r_shortv(): boolean {
    lab0: {
      const v_1: number = this.limit - this.c
      lab1: {
        if (!this.out_grouping_b(g_v_WXY, 89, 121)) break lab1
        if (!this.in_grouping_b(g_v, 97, 121)) break lab1
        if (!this.out_grouping_b(g_v, 97, 121)) break lab1
        break lab0
      }
      this.c = this.limit - v_1
      lab2: {
        if (!this.out_grouping_b(g_v, 97, 121)) break lab2
        if (!this.in_grouping_b(g_v, 97, 121)) break lab2
        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab2
        break lab0
      }
      this.c = this.limit - v_1
      if (!this.eq_s_b('past')) return false
    }
    return true
  }

  #stem(): boolean {
    let a: number
    let B_Y_found: boolean
    let I_p2: number
    let I_p1: number
    lab0: {
      const v_1: number = this.c
      lab1: {
        this.bra = this.c
        a = this.find_among(a_11)
        if (a === 0) break lab1
        this.ket = this.c
        if (/**@type {boolean}*/ (this.c < this.limit)) break lab1
        if (a > 0) {
          this.slice_from(as_11[a - 1])
        }
        break lab0
      }
      this.c = v_1
      lab2: {
        lab3: {
          if (this.c + 3 > this.limit) break lab3
          this.c += 3
          break lab2
        }
        break lab0
      }
      this.c = v_1
      {
        B_Y_found = false
        const v_2: number = this.c
        lab5: {
          this.bra = this.c
          if (!this.eq_s("'")) break lab5
          this.ket = this.c
          this.slice_del()
        }
        this.c = v_2
        const v_3: number = this.c
        lab6: {
          this.bra = this.c
          if (!this.eq_s('y')) break lab6
          this.ket = this.c
          this.slice_from('Y')
          B_Y_found = true
        }
        this.c = v_3
        const v_4: number = this.c
        while (true) {
          const v_5: number = this.c
          lab8: {
            while (true) {
              const v_6: number = this.c
              lab10: {
                if (!this.in_grouping(g_v, 97, 121)) break lab10
                this.bra = this.c
                if (!this.eq_s('y')) break lab10
                this.ket = this.c
                this.c = v_6
                break
              }
              this.c = v_6
              if (this.c >= this.limit) break lab8
              this.c++
            }
            this.slice_from('Y')
            B_Y_found = true
            continue
          }
          this.c = v_5
          break
        }
        this.c = v_4
      }
      {
        I_p1 = this.limit
        I_p2 = this.limit
        const v_7: number = this.c
        lab12: {
          lab13: {
            const v_8: number = this.c
            lab14: {
              if (this.find_among(a_0) === 0) break lab14
              break lab13
            }
            this.c = v_8
            if (!this.go_out_grouping(g_v, 97, 121)) break lab12
            this.c++
            if (!this.go_in_grouping(g_v, 97, 121)) break lab12
            this.c++
          }
          I_p1 = this.c
          if (!this.go_out_grouping(g_v, 97, 121)) break lab12
          this.c++
          if (!this.go_in_grouping(g_v, 97, 121)) break lab12
          this.c++
          I_p2 = this.c
        }
        this.c = v_7
      }
      this.limit_backward = this.c
      this.c = this.limit
      const v_9: number = this.limit - this.c
      lab15: {
        const v_10: number = this.limit - this.c
        lab16: {
          this.ket = this.c
          if (this.find_among_b(a_1) === 0) {
            this.c = this.limit - v_10
            break lab16
          }
          this.bra = this.c
          this.slice_del()
        }
        this.ket = this.c
        a = this.find_among_b(a_2)
        if (a === 0) break lab15
        this.bra = this.c
        switch (a) {
          case 1: {
            this.slice_from('ss')
            break
          }
          case 2: {
            lab17: {
              const v_11: number = this.limit - this.c
              lab18: {
                if (this.c - 2 < this.limit_backward) break lab18
                this.c -= 2
                this.slice_from('i')
                break lab17
              }
              this.c = this.limit - v_11
              this.slice_from('ie')
            }
            break
          }
          case 3: {
            if (this.c <= this.limit_backward) break lab15
            this.c--
            if (!this.go_out_grouping_b(g_v, 97, 121)) break lab15
            this.c--
            this.slice_del()
            break
          }
        }
      }
      this.c = this.limit - v_9
      const v_12: number = this.limit - this.c
      lab19: {
        this.ket = this.c
        a = this.find_among_b(a_5)
        this.bra = this.c
        lab20: {
          const v_13: number = this.limit - this.c
          lab21: {
            switch (a) {
              case 1: {
                const v_14: number = this.limit - this.c
                lab22: {
                  if (/**@type {boolean}*/ (I_p1 > this.c)) break lab22
                  lab23: {
                    const v_15: number = this.limit - this.c
                    lab24: {
                      if (this.find_among_b(a_3) === 0) break lab24
                      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab24
                      break lab23
                    }
                    this.c = this.limit - v_15
                    this.slice_from('ee')
                  }
                }
                this.c = this.limit - v_14
                break
              }
              case 2: {
                break lab21
              }
              case 3: {
                a = this.find_among_b(a_4)
                if (a === 0) break lab21
                switch (a) {
                  case 1: {
                    const v_16: number = this.limit - this.c
                    if (!this.out_grouping_b(g_v, 97, 121)) break lab21
                    if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab21
                    this.c = this.limit - v_16
                    this.bra = this.c
                    this.slice_from('ie')
                    break
                  }
                  case 2: {
                    if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab21
                    break
                  }
                }
                break
              }
            }
            break lab20
          }
          this.c = this.limit - v_13
          const v_17: number = this.limit - this.c
          if (!this.go_out_grouping_b(g_v, 97, 121)) break lab19
          this.c--
          this.c = this.limit - v_17
          this.slice_del()
          this.ket = this.c
          this.bra = this.c
          const v_18: number = this.limit - this.c
          a = this.find_among_b(a_6)
          switch (a) {
            case 1: {
              this.slice_from('e')
              break lab19
            }
            case 2: {
              {
                const v_19: number = this.limit - this.c
                lab25: {
                  if (!this.in_grouping_b(g_aeo, 97, 111)) break lab25
                  if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab25
                  break lab19
                }
                this.c = this.limit - v_19
              }
              break
            }
            case 3: {
              if (/**@type {boolean}*/ (this.c !== I_p1)) break lab19
              const v_20: number = this.limit - this.c
              if (!this.#r_shortv()) break lab19
              this.c = this.limit - v_20
              this.slice_from('e')
              break lab19
            }
          }
          this.c = this.limit - v_18
          this.ket = this.c
          if (this.c <= this.limit_backward) break lab19
          this.c--
          this.bra = this.c
          this.slice_del()
        }
      }
      this.c = this.limit - v_12
      const v_21: number = this.limit - this.c
      lab26: {
        this.ket = this.c
        lab27: {
          lab28: {
            if (!this.eq_s_b('y')) break lab28
            break lab27
          }
          if (!this.eq_s_b('Y')) break lab26
        }
        this.bra = this.c
        if (!this.out_grouping_b(g_v, 97, 121)) break lab26
        if (/**@type {boolean}*/ (this.c <= this.limit_backward)) break lab26
        this.slice_from('i')
      }
      this.c = this.limit - v_21
      const v_22: number = this.limit - this.c
      lab29: {
        this.ket = this.c
        a = this.find_among_b(a_7)
        if (a === 0) break lab29
        this.bra = this.c
        if (/**@type {boolean}*/ (I_p1 > this.c)) break lab29
        switch (a) {
          case 1: {
            this.slice_from('tion')
            break
          }
          case 2: {
            this.slice_from('ence')
            break
          }
          case 3: {
            this.slice_from('ance')
            break
          }
          case 4: {
            this.slice_from('able')
            break
          }
          case 5: {
            this.slice_from('ent')
            break
          }
          case 6: {
            this.slice_from('ize')
            break
          }
          case 7: {
            this.slice_from('ate')
            break
          }
          case 8: {
            this.slice_from('al')
            break
          }
          case 9: {
            this.slice_from('ful')
            break
          }
          case 10: {
            this.slice_from('ous')
            break
          }
          case 11: {
            this.slice_from('ive')
            break
          }
          case 12: {
            this.slice_from('ble')
            break
          }
          case 13: {
            this.slice_from('og')
            break
          }
          case 14: {
            if (!this.eq_s_b('l')) break lab29
            this.slice_from('og')
            break
          }
          case 15: {
            this.slice_from('less')
            break
          }
          case 16: {
            if (!this.in_grouping_b(g_valid_LI, 99, 116)) break lab29
            this.slice_del()
            break
          }
        }
      }
      this.c = this.limit - v_22
      const v_23: number = this.limit - this.c
      lab30: {
        this.ket = this.c
        a = this.find_among_b(a_8)
        if (a === 0) break lab30
        this.bra = this.c
        if (/**@type {boolean}*/ (I_p1 > this.c)) break lab30
        switch (a) {
          case 1: {
            this.slice_from('tion')
            break
          }
          case 2: {
            this.slice_from('ate')
            break
          }
          case 3: {
            this.slice_from('al')
            break
          }
          case 4: {
            this.slice_from('ic')
            break
          }
          case 5: {
            this.slice_del()
            break
          }
          case 6: {
            if (/**@type {boolean}*/ (I_p2 > this.c)) break lab30
            this.slice_del()
            break
          }
        }
      }
      this.c = this.limit - v_23
      const v_24: number = this.limit - this.c
      lab31: {
        this.ket = this.c
        a = this.find_among_b(a_9)
        if (a === 0) break lab31
        this.bra = this.c
        if (/**@type {boolean}*/ (I_p2 > this.c)) break lab31
        switch (a) {
          case 1: {
            this.slice_del()
            break
          }
          case 2: {
            lab32: {
              lab33: {
                if (!this.eq_s_b('s')) break lab33
                break lab32
              }
              if (!this.eq_s_b('t')) break lab31
            }
            this.slice_del()
            break
          }
        }
      }
      this.c = this.limit - v_24
      const v_25: number = this.limit - this.c
      lab34: {
        this.ket = this.c
        a = this.find_among_b(a_10)
        if (a === 0) break lab34
        this.bra = this.c
        switch (a) {
          case 1: {
            lab35: {
              lab36: {
                if (/**@type {boolean}*/ (I_p2 > this.c)) break lab36
                break lab35
              }
              if (/**@type {boolean}*/ (I_p1 > this.c)) break lab34
              {
                const v_26: number = this.limit - this.c
                lab37: {
                  if (!this.#r_shortv()) break lab37
                  break lab34
                }
                this.c = this.limit - v_26
              }
            }
            this.slice_del()
            break
          }
          case 2: {
            if (/**@type {boolean}*/ (I_p2 > this.c)) break lab34
            if (!this.eq_s_b('l')) break lab34
            this.slice_del()
            break
          }
        }
      }
      this.c = this.limit - v_25
      this.c = this.limit_backward
      const v_27: number = this.c
      lab38: {
        if (!B_Y_found) break lab38
        while (true) {
          const v_28: number = this.c
          lab39: {
            while (true) {
              const v_29: number = this.c
              lab41: {
                this.bra = this.c
                if (!this.eq_s('Y')) break lab41
                this.ket = this.c
                this.c = v_29
                break
              }
              this.c = v_29
              if (this.c >= this.limit) break lab39
              this.c++
            }
            this.slice_from('y')
            continue
          }
          this.c = v_28
          break
        }
      }
      this.c = v_27
    }
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new EnglishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'ebae3448ae674b59'
