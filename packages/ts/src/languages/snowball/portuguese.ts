/*
 * Generated from algorithms/portuguese.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision c0a0c5c97ab9ca6e
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['', 3],
  ['\u00E3', 1, 1],
  ['\u00F5', 2, 2],
]

const a_1: Among[] = [
  ['', 3],
  ['a~', 1, 1],
  ['o~', 2, 2],
]

const a_2: Among[] = [
  ['ic', -1],
  ['ad', -1],
  ['os', -1],
  ['iv', 1],
]

const a_3: Among[] = [
  ['ante', 1],
  ['avel', 1],
  ['\u00EDvel', 1],
]

const a_4: Among[] = [
  ['ic', 1],
  ['abil', 1],
  ['iv', 1],
]

const a_5: Among[] = [
  ['ica', 1],
  ['\u00E2ncia', 1],
  ['\u00EAncia', 4],
  ['logia', 2],
  ['ira', 9],
  ['adora', 1],
  ['osa', 1],
  ['ista', 1],
  ['iva', 8],
  ['eza', 1],
  ['idade', 7],
  ['ante', 1],
  ['mente', 6],
  ['amente', 5, 1],
  ['\u00E1vel', 1],
  ['\u00EDvel', 1],
  ['ico', 1],
  ['ismo', 1],
  ['oso', 1],
  ['amento', 1],
  ['imento', 1],
  ['ivo', 8],
  ['a\u00E7a~o', 1],
  ['u\u00E7a~o', 3],
  ['ador', 1],
  ['icas', 1],
  ['\u00EAncias', 4],
  ['logias', 2],
  ['iras', 9],
  ['adoras', 1],
  ['osas', 1],
  ['istas', 1],
  ['ivas', 8],
  ['ezas', 1],
  ['idades', 7],
  ['adores', 1],
  ['antes', 1],
  ['a\u00E7o~es', 1],
  ['u\u00E7o~es', 3],
  ['icos', 1],
  ['ismos', 1],
  ['osos', 1],
  ['amentos', 1],
  ['imentos', 1],
  ['ivos', 8],
]

const a_6: Among[] = [
  ['ada', 1],
  ['ida', 1],
  ['ia', 1],
  ['aria', 1, 1],
  ['eria', 1, 2],
  ['iria', 1, 3],
  ['ara', 1],
  ['era', 1],
  ['ira', 1],
  ['ava', 1],
  ['asse', 1],
  ['esse', 1],
  ['isse', 1],
  ['aste', 1],
  ['este', 1],
  ['iste', 1],
  ['ei', 1],
  ['arei', 1, 1],
  ['erei', 1, 2],
  ['irei', 1, 3],
  ['am', 1],
  ['iam', 1, 1],
  ['ariam', 1, 1],
  ['eriam', 1, 2],
  ['iriam', 1, 3],
  ['aram', 1, 5],
  ['eram', 1, 6],
  ['iram', 1, 7],
  ['avam', 1, 8],
  ['em', 1],
  ['arem', 1, 1],
  ['erem', 1, 2],
  ['irem', 1, 3],
  ['assem', 1, 4],
  ['essem', 1, 5],
  ['issem', 1, 6],
  ['ado', 1],
  ['ido', 1],
  ['ando', 1],
  ['endo', 1],
  ['indo', 1],
  ['ara~o', 1],
  ['era~o', 1],
  ['ira~o', 1],
  ['ar', 1],
  ['er', 1],
  ['ir', 1],
  ['as', 1],
  ['adas', 1, 1],
  ['idas', 1, 2],
  ['ias', 1, 3],
  ['arias', 1, 1],
  ['erias', 1, 2],
  ['irias', 1, 3],
  ['aras', 1, 7],
  ['eras', 1, 8],
  ['iras', 1, 9],
  ['avas', 1, 10],
  ['es', 1],
  ['ardes', 1, 1],
  ['erdes', 1, 2],
  ['irdes', 1, 3],
  ['ares', 1, 4],
  ['eres', 1, 5],
  ['ires', 1, 6],
  ['asses', 1, 7],
  ['esses', 1, 8],
  ['isses', 1, 9],
  ['astes', 1, 10],
  ['estes', 1, 11],
  ['istes', 1, 12],
  ['is', 1],
  ['ais', 1, 1],
  ['eis', 1, 2],
  ['areis', 1, 1],
  ['ereis', 1, 2],
  ['ireis', 1, 3],
  ['\u00E1reis', 1, 4],
  ['\u00E9reis', 1, 5],
  ['\u00EDreis', 1, 6],
  ['\u00E1sseis', 1, 7],
  ['\u00E9sseis', 1, 8],
  ['\u00EDsseis', 1, 9],
  ['\u00E1veis', 1, 10],
  ['\u00EDeis', 1, 11],
  ['ar\u00EDeis', 1, 1],
  ['er\u00EDeis', 1, 2],
  ['ir\u00EDeis', 1, 3],
  ['ados', 1],
  ['idos', 1],
  ['amos', 1],
  ['\u00E1ramos', 1, 1],
  ['\u00E9ramos', 1, 2],
  ['\u00EDramos', 1, 3],
  ['\u00E1vamos', 1, 4],
  ['\u00EDamos', 1, 5],
  ['ar\u00EDamos', 1, 1],
  ['er\u00EDamos', 1, 2],
  ['ir\u00EDamos', 1, 3],
  ['emos', 1],
  ['aremos', 1, 1],
  ['eremos', 1, 2],
  ['iremos', 1, 3],
  ['\u00E1ssemos', 1, 4],
  ['\u00EAssemos', 1, 5],
  ['\u00EDssemos', 1, 6],
  ['imos', 1],
  ['armos', 1],
  ['ermos', 1],
  ['irmos', 1],
  ['\u00E1mos', 1],
  ['ar\u00E1s', 1],
  ['er\u00E1s', 1],
  ['ir\u00E1s', 1],
  ['eu', 1],
  ['iu', 1],
  ['ou', 1],
  ['ar\u00E1', 1],
  ['er\u00E1', 1],
  ['ir\u00E1', 1],
]

const a_7: Among[] = [
  ['a', 1],
  ['i', 1],
  ['o', 1],
  ['os', 1],
  ['\u00E1', 1],
  ['\u00ED', 1],
  ['\u00F3', 1],
]

const a_8: Among[] = [
  ['e', 1],
  ['\u00E7', 2],
  ['\u00E9', 1],
  ['\u00EA', 1],
]

const g_v: number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 19, 12, 2]

export class PortugueseStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let I_p2: number
    let I_p1: number
    let I_pV: number
    const v_1: number = this.c
    while (true) {
      const v_2: number = this.c
      lab1: {
        this.bra = this.c
        a = this.find_among(a_0)
        this.ket = this.c
        switch (a) {
          case 1: {
            this.slice_from('a~')
            break
          }
          case 2: {
            this.slice_from('o~')
            break
          }
          case 3: {
            if (this.c >= this.limit) break lab1
            this.c++
            break
          }
        }
        continue
      }
      this.c = v_2
      break
    }
    this.c = v_1
    {
      I_pV = this.limit
      I_p1 = this.limit
      I_p2 = this.limit
      const v_3: number = this.c
      lab3: {
        lab4: {
          const v_4: number = this.c
          lab5: {
            if (!this.in_grouping(g_v, 97, 250)) break lab5
            lab6: {
              const v_5: number = this.c
              lab7: {
                if (!this.out_grouping(g_v, 97, 250)) break lab7
                if (!this.go_out_grouping(g_v, 97, 250)) break lab7
                this.c++
                break lab6
              }
              this.c = v_5
              if (!this.in_grouping(g_v, 97, 250)) break lab5
              if (!this.go_in_grouping(g_v, 97, 250)) break lab5
              this.c++
            }
            break lab4
          }
          this.c = v_4
          if (!this.out_grouping(g_v, 97, 250)) break lab3
          lab8: {
            const v_6: number = this.c
            lab9: {
              if (!this.out_grouping(g_v, 97, 250)) break lab9
              if (!this.go_out_grouping(g_v, 97, 250)) break lab9
              this.c++
              break lab8
            }
            this.c = v_6
            if (!this.in_grouping(g_v, 97, 250)) break lab3
            if (this.c >= this.limit) break lab3
            this.c++
          }
        }
        I_pV = this.c
      }
      this.c = v_3
      const v_7: number = this.c
      lab10: {
        if (!this.go_out_grouping(g_v, 97, 250)) break lab10
        this.c++
        if (!this.go_in_grouping(g_v, 97, 250)) break lab10
        this.c++
        I_p1 = this.c
        if (!this.go_out_grouping(g_v, 97, 250)) break lab10
        this.c++
        if (!this.go_in_grouping(g_v, 97, 250)) break lab10
        this.c++
        I_p2 = this.c
      }
      this.c = v_7
    }
    this.limit_backward = this.c
    this.c = this.limit
    const v_8: number = this.limit - this.c
    lab11: {
      lab12: {
        const v_9: number = this.limit - this.c
        lab13: {
          const v_10: number = this.limit - this.c
          lab14: {
            const v_11: number = this.limit - this.c
            lab15: {
              this.ket = this.c
              a = this.find_among_b(a_5)
              if (a === 0) break lab15
              this.bra = this.c
              switch (a) {
                case 1: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
                  this.slice_del()
                  break
                }
                case 2: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
                  this.slice_from('log')
                  break
                }
                case 3: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
                  this.slice_from('u')
                  break
                }
                case 4: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
                  this.slice_from('ente')
                  break
                }
                case 5: {
                  if (/**@type {boolean}*/ (I_p1 > this.c)) break lab15
                  this.slice_del()
                  const v_12: number = this.limit - this.c
                  lab16: {
                    this.ket = this.c
                    a = this.find_among_b(a_2)
                    if (a === 0) {
                      this.c = this.limit - v_12
                      break lab16
                    }
                    this.bra = this.c
                    if (/**@type {boolean}*/ (I_p2 > this.c)) {
                      this.c = this.limit - v_12
                      break lab16
                    }
                    this.slice_del()
                    switch (a) {
                      case 1: {
                        this.ket = this.c
                        if (!this.eq_s_b('at')) {
                          this.c = this.limit - v_12
                          break lab16
                        }
                        this.bra = this.c
                        if (/**@type {boolean}*/ (I_p2 > this.c)) {
                          this.c = this.limit - v_12
                          break lab16
                        }
                        this.slice_del()
                        break
                      }
                    }
                  }
                  break
                }
                case 6: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
                  this.slice_del()
                  const v_13: number = this.limit - this.c
                  lab17: {
                    this.ket = this.c
                    if (this.find_among_b(a_3) === 0) {
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
                case 7: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
                  this.slice_del()
                  const v_14: number = this.limit - this.c
                  lab18: {
                    this.ket = this.c
                    if (this.find_among_b(a_4) === 0) {
                      this.c = this.limit - v_14
                      break lab18
                    }
                    this.bra = this.c
                    if (/**@type {boolean}*/ (I_p2 > this.c)) {
                      this.c = this.limit - v_14
                      break lab18
                    }
                    this.slice_del()
                  }
                  break
                }
                case 8: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab15
                  this.slice_del()
                  const v_15: number = this.limit - this.c
                  lab19: {
                    this.ket = this.c
                    if (!this.eq_s_b('at')) {
                      this.c = this.limit - v_15
                      break lab19
                    }
                    this.bra = this.c
                    if (/**@type {boolean}*/ (I_p2 > this.c)) {
                      this.c = this.limit - v_15
                      break lab19
                    }
                    this.slice_del()
                  }
                  break
                }
                case 9: {
                  if (/**@type {boolean}*/ (I_pV > this.c)) break lab15
                  if (!this.eq_s_b('e')) break lab15
                  this.slice_from('ir')
                  break
                }
              }
              break lab14
            }
            this.c = this.limit - v_11
            if (this.c < I_pV) break lab13
            const v_16: number = this.limit_backward
            this.limit_backward = I_pV
            this.ket = this.c
            if (this.find_among_b(a_6) === 0) {
              this.limit_backward = v_16
              break lab13
            }
            this.bra = this.c
            this.slice_del()
            this.limit_backward = v_16
          }
          this.c = this.limit - v_10
          const v_17: number = this.limit - this.c
          lab20: {
            this.ket = this.c
            if (!this.eq_s_b('i')) break lab20
            this.bra = this.c
            const v_18: number = this.limit - this.c
            if (!this.eq_s_b('c')) break lab20
            this.c = this.limit - v_18
            if (/**@type {boolean}*/ (I_pV > this.c)) break lab20
            this.slice_del()
          }
          this.c = this.limit - v_17
          break lab12
        }
        this.c = this.limit - v_9
        this.ket = this.c
        if (this.find_among_b(a_7) === 0) break lab11
        this.bra = this.c
        if (/**@type {boolean}*/ (I_pV > this.c)) break lab11
        this.slice_del()
      }
    }
    this.c = this.limit - v_8
    const v_19: number = this.limit - this.c
    lab21: {
      this.ket = this.c
      a = this.find_among_b(a_8)
      if (a === 0) break lab21
      this.bra = this.c
      switch (a) {
        case 1: {
          if (/**@type {boolean}*/ (I_pV > this.c)) break lab21
          this.slice_del()
          this.ket = this.c
          lab22: {
            const v_20: number = this.limit - this.c
            lab23: {
              if (!this.eq_s_b('u')) break lab23
              this.bra = this.c
              const v_21: number = this.limit - this.c
              if (!this.eq_s_b('g')) break lab23
              this.c = this.limit - v_21
              break lab22
            }
            this.c = this.limit - v_20
            if (!this.eq_s_b('i')) break lab21
            this.bra = this.c
            const v_22: number = this.limit - this.c
            if (!this.eq_s_b('c')) break lab21
            this.c = this.limit - v_22
          }
          if (/**@type {boolean}*/ (I_pV > this.c)) break lab21
          this.slice_del()
          break
        }
        case 2: {
          this.slice_from('c')
          break
        }
      }
    }
    this.c = this.limit - v_19
    this.c = this.limit_backward
    const v_23: number = this.c
    while (true) {
      const v_24: number = this.c
      lab25: {
        this.bra = this.c
        a = this.find_among(a_1)
        this.ket = this.c
        switch (a) {
          case 1: {
            this.slice_from('\u00E3')
            break
          }
          case 2: {
            this.slice_from('\u00F5')
            break
          }
          case 3: {
            if (this.c >= this.limit) break lab25
            this.c++
            break
          }
        }
        continue
      }
      this.c = v_24
      break
    }
    this.c = v_23
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new PortugueseStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'c0a0c5c97ab9ca6e'
