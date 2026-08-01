/*
 * Generated from algorithms/esperanto.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision dacc9f709c07f8ad
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['', 14],
  ['-', 13, 1],
  ['cx', 1, 2],
  ['gx', 2, 3],
  ['hx', 3, 4],
  ['jx', 4, 5],
  ['q', 12, 6],
  ['sx', 5, 7],
  ['ux', 6, 8],
  ['w', 12, 9],
  ['x', 12, 10],
  ['y', 12, 11],
  ['\u00E1', 7, 12],
  ['\u00E9', 8, 13],
  ['\u00ED', 9, 14],
  ['\u00F3', 10, 15],
  ['\u00FA', 11, 16],
]

const a_1: Among[] = [
  ['as', -1],
  ['i', -1],
  ['is', -1, 1],
  ['os', -1],
  ['u', -1],
  ['us', -1, 1],
]

const a_2: Among[] = [
  ['ci', -1],
  ['gi', -1],
  ['hi', -1],
  ['li', -1],
  ['ili', -1, 1],
  ['\u015Dli', -1, 2],
  ['mi', -1],
  ['ni', -1],
  ['oni', -1, 1],
  ['ri', -1],
  ['si', -1],
  ['vi', -1],
  ['ivi', -1, 1],
  ['\u011Di', -1],
  ['\u015Di', -1],
  ['i\u015Di', -1, 1],
  ['mal\u015Di', -1, 2],
]

const a_3: Among[] = [
  ['amb', -1],
  ['bald', -1],
  ['malbald', -1, 1],
  ['morg', -1],
  ['postmorg', -1, 1],
  ['adi', -1],
  ['hodi', -1],
  ['ank', -1],
  ['\u0109irk', -1],
  ['tut\u0109irk', -1, 1],
  ['presk', -1],
  ['almen', -1],
  ['apen', -1],
  ['hier', -1],
  ['anta\u016Dhier', -1, 1],
  ['malgr', -1],
  ['ankor', -1],
  ['kontr', -1],
  ['anstat', -1],
  ['kvaz', -1],
]

const a_4: Among[] = [
  ['aliu', -1],
  ['unu', -1],
]

const a_5: Among[] = [
  ['aha', -1],
  ['haha', -1, 1],
  ['haleluja', -1],
  ['hola', -1],
  ['hosana', -1],
  ['maltra', -1],
  ['hura', -1],
  ['\u0125a\u0125a', -1],
  ['ekde', -1],
  ['elde', -1],
  ['disde', -1],
  ['ehe', -1],
  ['maltre', -1],
  ['dirlididi', -1],
  ['malpli', -1],
  ['mal\u0109i', -1],
  ['malkaj', -1],
  ['amen', -1],
  ['tamen', -1, 1],
  ['oho', -1],
  ['maltro', -1],
  ['minus', -1],
  ['uhu', -1],
  ['muu', -1],
]

const a_6: Among[] = [
  ['tri', -1],
  ['du', -1],
  ['unu', -1],
]

const a_7: Among[] = [
  ['dek', -1],
  ['cent', -1],
]

const a_8: Among[] = [
  ['k', -1],
  ['kelk', -1, 1],
  ['nen', -1],
  ['t', -1],
  ['mult', -1, 1],
  ['samt', -1, 2],
  ['\u0109', -1],
]

const a_9: Among[] = [
  ['a', -1],
  ['e', -1],
  ['i', -1],
  ['j', 1],
  ['aj', -1, 1],
  ['oj', -1, 2],
  ['n', 1],
  ['an', -1, 1],
  ['en', -1, 2],
  ['jn', 1, 3],
  ['ajn', -1, 1],
  ['ojn', -1, 2],
  ['on', -1, 6],
  ['o', -1],
  ['as', -1],
  ['is', -1],
  ['os', -1],
  ['us', -1],
  ['u', -1],
]

const g_vowel: number[] = [17, 65, 16]

const g_aou: number[] = [1, 64, 16]

const g_digit: number[] = [255, 3]

export class EsperantoStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let B_foreign: boolean
    const v_1: number = this.c
    B_foreign = false
    while (true) {
      const v_2: number = this.c
      lab0: {
        this.bra = this.c
        a = this.find_among(a_0)
        this.ket = this.c
        switch (a) {
          case 1: {
            this.slice_from('\u0109')
            break
          }
          case 2: {
            this.slice_from('\u011D')
            break
          }
          case 3: {
            this.slice_from('\u0125')
            break
          }
          case 4: {
            this.slice_from('\u0135')
            break
          }
          case 5: {
            this.slice_from('\u015D')
            break
          }
          case 6: {
            this.slice_from('\u016D')
            break
          }
          case 7: {
            this.slice_from('a')
            B_foreign = true
            break
          }
          case 8: {
            this.slice_from('e')
            B_foreign = true
            break
          }
          case 9: {
            this.slice_from('i')
            B_foreign = true
            break
          }
          case 10: {
            this.slice_from('o')
            B_foreign = true
            break
          }
          case 11: {
            this.slice_from('u')
            B_foreign = true
            break
          }
          case 12: {
            B_foreign = true
            break
          }
          case 13: {
            B_foreign = false
            break
          }
          case 14: {
            if (this.c >= this.limit) break lab0
            this.c++
            break
          }
        }
        continue
      }
      this.c = v_2
      break
    }
    if (B_foreign) return false
    this.c = v_1
    const v_3: number = this.c
    lab1: {
      this.bra = this.c
      if (!this.eq_s("'")) break lab1
      this.ket = this.c
      if (!this.eq_s('st')) break lab1
      if (this.find_among(a_1) === 0) break lab1
      if (/**@type {boolean}*/ (this.c < this.limit)) break lab1
      this.slice_from('e')
    }
    this.c = v_3
    this.limit_backward = this.c
    this.c = this.limit
    {
      const v_4: number = this.limit - this.c
      lab2: {
        this.ket = this.c
        const v_5: number = this.limit - this.c
        lab3: {
          if (!this.eq_s_b('n')) {
            this.c = this.limit - v_5
            break lab3
          }
        }
        this.bra = this.c
        if (this.find_among_b(a_2) === 0) break lab2
        lab4: {
          lab5: {
            if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab5
            break lab4
          }
          if (!this.eq_s_b('-')) break lab2
        }
        this.slice_del()
        return false
      }
      this.c = this.limit - v_4
    }
    const v_6: number = this.limit - this.c
    lab6: {
      this.ket = this.c
      if (!this.eq_s_b("'")) break lab6
      this.bra = this.c
      lab7: {
        const v_7: number = this.limit - this.c
        lab8: {
          if (!this.eq_s_b('l')) break lab8
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab8
          this.slice_from('a')
          break lab7
        }
        this.c = this.limit - v_7
        lab9: {
          if (!this.eq_s_b('un')) break lab9
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab9
          this.slice_from('u')
          break lab7
        }
        this.c = this.limit - v_7
        lab10: {
          if (this.find_among_b(a_3) === 0) break lab10
          lab11: {
            lab12: {
              if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab12
              break lab11
            }
            if (!this.eq_s_b('-')) break lab10
          }
          this.slice_from('a\u016D')
          break lab7
        }
        this.c = this.limit - v_7
        this.slice_from('o')
      }
    }
    this.c = this.limit - v_6
    {
      const v_8: number = this.limit - this.c
      lab13: {
        this.ket = this.c
        this.bra = this.c
        const v_9: number = this.limit - this.c
        lab14: {
          const v_10: number = this.limit - this.c
          lab15: {
            const v_11: number = this.limit - this.c
            lab16: {
              if (!this.eq_s_b('n')) {
                this.c = this.limit - v_11
                break lab16
              }
            }
            this.bra = this.c
            if (!this.eq_s_b('e')) break lab15
            break lab14
          }
          this.c = this.limit - v_10
          const v_12: number = this.limit - this.c
          lab17: {
            if (!this.eq_s_b('n')) {
              this.c = this.limit - v_12
              break lab17
            }
          }
          const v_13: number = this.limit - this.c
          lab18: {
            if (!this.eq_s_b('j')) {
              this.c = this.limit - v_13
              break lab18
            }
          }
          this.bra = this.c
          if (!this.in_grouping_b(g_aou, 97, 117)) break lab13
        }
        if (!this.eq_s_b('i')) break lab13
        const v_14: number = this.limit - this.c
        lab19: {
          if (this.find_among_b(a_8) === 0) {
            this.c = this.limit - v_14
            break lab19
          }
        }
        lab20: {
          lab21: {
            if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab21
            break lab20
          }
          if (!this.eq_s_b('-')) break lab13
        }
        this.c = this.limit - v_9
        this.slice_del()
        return false
      }
      this.c = this.limit - v_8
    }
    {
      const v_15: number = this.limit - this.c
      lab22: {
        if (this.find_among_b(a_5) === 0) break lab22
        lab23: {
          lab24: {
            if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab24
            break lab23
          }
          if (!this.eq_s_b('-')) break lab22
        }
        return false
      }
      this.c = this.limit - v_15
    }
    {
      const v_16: number = this.limit - this.c
      lab25: {
        if (this.find_among_b(a_6) === 0) break lab25
        if (this.find_among_b(a_7) === 0) break lab25
        return false
      }
      this.c = this.limit - v_16
    }
    {
      const v_17: number = this.limit - this.c
      lab26: {
        this.ket = this.c
        const v_18: number = this.limit - this.c
        lab27: {
          if (!this.eq_s_b('n')) {
            this.c = this.limit - v_18
            break lab27
          }
        }
        const v_19: number = this.limit - this.c
        lab28: {
          if (!this.eq_s_b('j')) {
            this.c = this.limit - v_19
            break lab28
          }
        }
        this.bra = this.c
        if (this.find_among_b(a_4) === 0) break lab26
        lab29: {
          lab30: {
            if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab30
            break lab29
          }
          if (!this.eq_s_b('-')) break lab26
        }
        this.slice_del()
        return false
      }
      this.c = this.limit - v_17
    }
    const v_20: number = this.limit - this.c
    lab31: {
      const v_21: number = this.limit - this.c
      lab32: {
        for (let v_22: number = 2; v_22 > 0; v_22--) {
          if (!this.go_out_grouping_b(g_vowel, 97, 117)) break lab32
          this.c--
        }
        break lab31
      }
      this.c = this.limit - v_21
      lab33: {
        while (true) {
          lab35: {
            if (!this.eq_s_b('-')) break lab35
            break
          }
          if (this.c <= this.limit_backward) break lab33
          this.c--
        }
        if (this.c <= this.limit_backward) break lab33
        this.c--
        break lab31
      }
      this.c = this.limit - v_21
      if (!this.go_out_grouping_b(g_digit, 48, 57)) return false
      this.c--
    }
    this.c = this.limit - v_20
    this.ket = this.c
    a = this.find_among_b(a_9)
    if (a === 0) return false
    switch (a) {
      case 1: {
        const v_23: number = this.limit - this.c
        lab36: {
          lab37: {
            if (!this.eq_s_b('-')) break lab37
            break lab36
          }
          if (!this.in_grouping_b(g_digit, 48, 57)) return false
        }
        this.c = this.limit - v_23
        break
      }
    }
    const v_24: number = this.limit - this.c
    lab38: {
      if (!this.eq_s_b('-')) {
        this.c = this.limit - v_24
        break lab38
      }
    }
    this.bra = this.c
    this.slice_del()
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new EsperantoStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'dacc9f709c07f8ad'
