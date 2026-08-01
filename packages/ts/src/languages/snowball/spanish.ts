/*
 * Generated from algorithms/spanish.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 8dc152fd2fcce882
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['', 6],
  ['\u00E1', 1, 1],
  ['\u00E9', 2, 2],
  ['\u00ED', 3, 3],
  ['\u00F3', 4, 4],
  ['\u00FA', 5, 5],
]

const a_1: Among[] = [
  ['la', -1],
  ['sela', -1, 1],
  ['le', -1],
  ['me', -1],
  ['se', -1],
  ['lo', -1],
  ['selo', -1, 1],
  ['las', -1],
  ['selas', -1, 1],
  ['les', -1],
  ['los', -1],
  ['selos', -1, 1],
  ['nos', -1],
]

const a_2: Among[] = [
  ['ando', 6],
  ['iendo', 6],
  ['yendo', 7],
  ['\u00E1ndo', 2],
  ['i\u00E9ndo', 1],
  ['ar', 6],
  ['er', 6],
  ['ir', 6],
  ['\u00E1r', 3],
  ['\u00E9r', 4],
  ['\u00EDr', 5],
]

const a_3: Among[] = [
  ['ic', -1],
  ['ad', -1],
  ['os', -1],
  ['iv', 1],
]

const a_4: Among[] = [
  ['able', 1],
  ['ible', 1],
  ['ante', 1],
]

const a_5: Among[] = [
  ['ic', 1],
  ['abil', 1],
  ['iv', 1],
]

const a_6: Among[] = [
  ['ica', 1],
  ['ancia', 2],
  ['encia', 5],
  ['adora', 2],
  ['osa', 1],
  ['ista', 1],
  ['iva', 9],
  ['anza', 1],
  ['log\u00EDa', 3],
  ['idad', 8],
  ['able', 1],
  ['ible', 1],
  ['ante', 2],
  ['mente', 7],
  ['amente', 6, 1],
  ['acion', 2],
  ['ucion', 4],
  ['aci\u00F3n', 2],
  ['uci\u00F3n', 4],
  ['ico', 1],
  ['ismo', 1],
  ['oso', 1],
  ['amiento', 1],
  ['imiento', 1],
  ['ivo', 9],
  ['ador', 2],
  ['icas', 1],
  ['ancias', 2],
  ['encias', 5],
  ['adoras', 2],
  ['osas', 1],
  ['istas', 1],
  ['ivas', 9],
  ['anzas', 1],
  ['log\u00EDas', 3],
  ['idades', 8],
  ['ables', 1],
  ['ibles', 1],
  ['aciones', 2],
  ['uciones', 4],
  ['adores', 2],
  ['antes', 2],
  ['icos', 1],
  ['ismos', 1],
  ['osos', 1],
  ['amientos', 1],
  ['imientos', 1],
  ['ivos', 9],
]

const a_7: Among[] = [
  ['ya', 1],
  ['ye', 1],
  ['yan', 1],
  ['yen', 1],
  ['yeron', 1],
  ['yendo', 1],
  ['yo', 1],
  ['yas', 1],
  ['yes', 1],
  ['yais', 1],
  ['yamos', 1],
  ['y\u00F3', 1],
]

const a_8: Among[] = [
  ['aba', 2],
  ['ada', 2],
  ['ida', 2],
  ['ara', 2],
  ['iera', 2],
  ['\u00EDa', 2],
  ['ar\u00EDa', 2, 1],
  ['er\u00EDa', 2, 2],
  ['ir\u00EDa', 2, 3],
  ['ad', 2],
  ['ed', 2],
  ['id', 2],
  ['ase', 2],
  ['iese', 2],
  ['aste', 2],
  ['iste', 2],
  ['an', 2],
  ['aban', 2, 1],
  ['aran', 2, 2],
  ['ieran', 2, 3],
  ['\u00EDan', 2, 4],
  ['ar\u00EDan', 2, 1],
  ['er\u00EDan', 2, 2],
  ['ir\u00EDan', 2, 3],
  ['en', 1],
  ['asen', 2, 1],
  ['iesen', 2, 2],
  ['aron', 2],
  ['ieron', 2],
  ['ar\u00E1n', 2],
  ['er\u00E1n', 2],
  ['ir\u00E1n', 2],
  ['ado', 2],
  ['ido', 2],
  ['ando', 2],
  ['iendo', 2],
  ['ar', 2],
  ['er', 2],
  ['ir', 2],
  ['as', 2],
  ['abas', 2, 1],
  ['adas', 2, 2],
  ['idas', 2, 3],
  ['aras', 2, 4],
  ['ieras', 2, 5],
  ['\u00EDas', 2, 6],
  ['ar\u00EDas', 2, 1],
  ['er\u00EDas', 2, 2],
  ['ir\u00EDas', 2, 3],
  ['es', 1],
  ['ases', 2, 1],
  ['ieses', 2, 2],
  ['abais', 2],
  ['arais', 2],
  ['ierais', 2],
  ['\u00EDais', 2],
  ['ar\u00EDais', 2, 1],
  ['er\u00EDais', 2, 2],
  ['ir\u00EDais', 2, 3],
  ['aseis', 2],
  ['ieseis', 2],
  ['asteis', 2],
  ['isteis', 2],
  ['\u00E1is', 2],
  ['\u00E9is', 1],
  ['ar\u00E9is', 2, 1],
  ['er\u00E9is', 2, 2],
  ['ir\u00E9is', 2, 3],
  ['ados', 2],
  ['idos', 2],
  ['amos', 2],
  ['\u00E1bamos', 2, 1],
  ['\u00E1ramos', 2, 2],
  ['i\u00E9ramos', 2, 3],
  ['\u00EDamos', 2, 4],
  ['ar\u00EDamos', 2, 1],
  ['er\u00EDamos', 2, 2],
  ['ir\u00EDamos', 2, 3],
  ['emos', 1],
  ['aremos', 2, 1],
  ['eremos', 2, 2],
  ['iremos', 2, 3],
  ['\u00E1semos', 2, 4],
  ['i\u00E9semos', 2, 5],
  ['imos', 2],
  ['ar\u00E1s', 2],
  ['er\u00E1s', 2],
  ['ir\u00E1s', 2],
  ['\u00EDs', 2],
  ['ar\u00E1', 2],
  ['er\u00E1', 2],
  ['ir\u00E1', 2],
  ['ar\u00E9', 2],
  ['er\u00E9', 2],
  ['ir\u00E9', 2],
  ['i\u00F3', 2],
]

const a_9: Among[] = [
  ['a', 1],
  ['e', 2],
  ['o', 1],
  ['os', 1],
  ['\u00E1', 1],
  ['\u00E9', 2],
  ['\u00ED', 1],
  ['\u00F3', 1],
]

const g_v: number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 10]

export class SpanishStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let I_p2: number
    let I_p1: number
    let I_pV: number
    {
      I_pV = this.limit
      I_p1 = this.limit
      I_p2 = this.limit
      const v_1: number = this.c
      lab1: {
        lab2: {
          const v_2: number = this.c
          lab3: {
            if (!this.in_grouping(g_v, 97, 252)) break lab3
            lab4: {
              const v_3: number = this.c
              lab5: {
                if (!this.out_grouping(g_v, 97, 252)) break lab5
                if (!this.go_out_grouping(g_v, 97, 252)) break lab5
                this.c++
                break lab4
              }
              this.c = v_3
              if (!this.in_grouping(g_v, 97, 252)) break lab3
              if (!this.go_in_grouping(g_v, 97, 252)) break lab3
              this.c++
            }
            break lab2
          }
          this.c = v_2
          if (!this.out_grouping(g_v, 97, 252)) break lab1
          lab6: {
            const v_4: number = this.c
            lab7: {
              if (!this.out_grouping(g_v, 97, 252)) break lab7
              if (!this.go_out_grouping(g_v, 97, 252)) break lab7
              this.c++
              break lab6
            }
            this.c = v_4
            if (!this.in_grouping(g_v, 97, 252)) break lab1
            if (this.c >= this.limit) break lab1
            this.c++
          }
        }
        I_pV = this.c
      }
      this.c = v_1
      const v_5: number = this.c
      lab8: {
        if (!this.go_out_grouping(g_v, 97, 252)) break lab8
        this.c++
        if (!this.go_in_grouping(g_v, 97, 252)) break lab8
        this.c++
        I_p1 = this.c
        if (!this.go_out_grouping(g_v, 97, 252)) break lab8
        this.c++
        if (!this.go_in_grouping(g_v, 97, 252)) break lab8
        this.c++
        I_p2 = this.c
      }
      this.c = v_5
    }
    this.limit_backward = this.c
    this.c = this.limit
    const v_6: number = this.limit - this.c
    lab9: {
      this.ket = this.c
      if (this.find_among_b(a_1) === 0) break lab9
      this.bra = this.c
      a = this.find_among_b(a_2)
      if (a === 0) break lab9
      if (/**@type {boolean}*/ (I_pV > this.c)) break lab9
      switch (a) {
        case 1: {
          this.bra = this.c
          this.slice_from('iendo')
          break
        }
        case 2: {
          this.bra = this.c
          this.slice_from('ando')
          break
        }
        case 3: {
          this.bra = this.c
          this.slice_from('ar')
          break
        }
        case 4: {
          this.bra = this.c
          this.slice_from('er')
          break
        }
        case 5: {
          this.bra = this.c
          this.slice_from('ir')
          break
        }
        case 6: {
          this.slice_del()
          break
        }
        case 7: {
          if (!this.eq_s_b('u')) break lab9
          this.slice_del()
          break
        }
      }
    }
    this.c = this.limit - v_6
    const v_7: number = this.limit - this.c
    lab10: {
      lab11: {
        const v_8: number = this.limit - this.c
        lab12: {
          this.ket = this.c
          a = this.find_among_b(a_6)
          if (a === 0) break lab12
          this.bra = this.c
          switch (a) {
            case 1: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_del()
              break
            }
            case 2: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_del()
              const v_9: number = this.limit - this.c
              lab13: {
                this.ket = this.c
                if (!this.eq_s_b('ic')) {
                  this.c = this.limit - v_9
                  break lab13
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_9
                  break lab13
                }
                this.slice_del()
              }
              break
            }
            case 3: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_from('log')
              break
            }
            case 4: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_from('u')
              break
            }
            case 5: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_from('ente')
              break
            }
            case 6: {
              if (/**@type {boolean}*/ (I_p1 > this.c)) break lab12
              this.slice_del()
              const v_10: number = this.limit - this.c
              lab14: {
                this.ket = this.c
                a = this.find_among_b(a_3)
                if (a === 0) {
                  this.c = this.limit - v_10
                  break lab14
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_10
                  break lab14
                }
                this.slice_del()
                switch (a) {
                  case 1: {
                    this.ket = this.c
                    if (!this.eq_s_b('at')) {
                      this.c = this.limit - v_10
                      break lab14
                    }
                    this.bra = this.c
                    if (/**@type {boolean}*/ (I_p2 > this.c)) {
                      this.c = this.limit - v_10
                      break lab14
                    }
                    this.slice_del()
                    break
                  }
                }
              }
              break
            }
            case 7: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_del()
              const v_11: number = this.limit - this.c
              lab15: {
                this.ket = this.c
                if (this.find_among_b(a_4) === 0) {
                  this.c = this.limit - v_11
                  break lab15
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_11
                  break lab15
                }
                this.slice_del()
              }
              break
            }
            case 8: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_del()
              const v_12: number = this.limit - this.c
              lab16: {
                this.ket = this.c
                if (this.find_among_b(a_5) === 0) {
                  this.c = this.limit - v_12
                  break lab16
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_12
                  break lab16
                }
                this.slice_del()
              }
              break
            }
            case 9: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab12
              this.slice_del()
              const v_13: number = this.limit - this.c
              lab17: {
                this.ket = this.c
                if (!this.eq_s_b('at')) {
                  this.c = this.limit - v_13
                  break lab17
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_13
                  break lab17
                }
                this.slice_del()
              }
              break
            }
          }
          break lab11
        }
        this.c = this.limit - v_8
        lab18: {
          if (this.c < I_pV) break lab18
          const v_14: number = this.limit_backward
          this.limit_backward = I_pV
          this.ket = this.c
          if (this.find_among_b(a_7) === 0) {
            this.limit_backward = v_14
            break lab18
          }
          this.bra = this.c
          this.limit_backward = v_14
          if (!this.eq_s_b('u')) break lab18
          this.slice_del()
          break lab11
        }
        this.c = this.limit - v_8
        if (this.c < I_pV) break lab10
        const v_15: number = this.limit_backward
        this.limit_backward = I_pV
        this.ket = this.c
        a = this.find_among_b(a_8)
        if (a === 0) {
          this.limit_backward = v_15
          break lab10
        }
        this.bra = this.c
        this.limit_backward = v_15
        switch (a) {
          case 1: {
            const v_16: number = this.limit - this.c
            lab19: {
              if (!this.eq_s_b('u')) {
                this.c = this.limit - v_16
                break lab19
              }
              const v_17: number = this.limit - this.c
              if (!this.eq_s_b('g')) {
                this.c = this.limit - v_16
                break lab19
              }
              this.c = this.limit - v_17
            }
            this.bra = this.c
            this.slice_del()
            break
          }
          case 2: {
            this.slice_del()
            break
          }
        }
      }
    }
    this.c = this.limit - v_7
    const v_18: number = this.limit - this.c
    lab20: {
      this.ket = this.c
      a = this.find_among_b(a_9)
      if (a === 0) break lab20
      this.bra = this.c
      switch (a) {
        case 1: {
          if (/**@type {boolean}*/ (I_pV > this.c)) break lab20
          this.slice_del()
          break
        }
        case 2: {
          if (/**@type {boolean}*/ (I_pV > this.c)) break lab20
          this.slice_del()
          const v_19: number = this.limit - this.c
          lab21: {
            this.ket = this.c
            if (!this.eq_s_b('u')) {
              this.c = this.limit - v_19
              break lab21
            }
            this.bra = this.c
            const v_20: number = this.limit - this.c
            if (!this.eq_s_b('g')) {
              this.c = this.limit - v_19
              break lab21
            }
            this.c = this.limit - v_20
            if (/**@type {boolean}*/ (I_pV > this.c)) {
              this.c = this.limit - v_19
              break lab21
            }
            this.slice_del()
          }
          break
        }
      }
    }
    this.c = this.limit - v_18
    this.c = this.limit_backward
    const v_21: number = this.c
    while (true) {
      const v_22: number = this.c
      lab23: {
        this.bra = this.c
        a = this.find_among(a_0)
        this.ket = this.c
        switch (a) {
          case 1: {
            this.slice_from('a')
            break
          }
          case 2: {
            this.slice_from('e')
            break
          }
          case 3: {
            this.slice_from('i')
            break
          }
          case 4: {
            this.slice_from('o')
            break
          }
          case 5: {
            this.slice_from('u')
            break
          }
          case 6: {
            if (this.c >= this.limit) break lab23
            this.c++
            break
          }
        }
        continue
      }
      this.c = v_22
      break
    }
    this.c = v_21
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new SpanishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '8dc152fd2fcce882'
