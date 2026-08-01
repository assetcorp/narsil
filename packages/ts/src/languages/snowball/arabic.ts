/*
 * Generated from algorithms/arabic.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision d9b491d016b4caf6
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['\u0640', 1],
  ['\u064B', 1],
  ['\u064C', 1],
  ['\u064D', 1],
  ['\u064E', 1],
  ['\u064F', 1],
  ['\u0650', 1],
  ['\u0651', 1],
  ['\u0652', 1],
  ['\u0660', 2],
  ['\u0661', 3],
  ['\u0662', 4],
  ['\u0663', 5],
  ['\u0664', 6],
  ['\u0665', 7],
  ['\u0666', 8],
  ['\u0667', 9],
  ['\u0668', 10],
  ['\u0669', 11],
  ['\uFE80', 12],
  ['\uFE81', 16],
  ['\uFE82', 16],
  ['\uFE83', 13],
  ['\uFE84', 13],
  ['\uFE85', 17],
  ['\uFE86', 17],
  ['\uFE87', 14],
  ['\uFE88', 14],
  ['\uFE89', 15],
  ['\uFE8A', 15],
  ['\uFE8B', 15],
  ['\uFE8C', 15],
  ['\uFE8D', 18],
  ['\uFE8E', 18],
  ['\uFE8F', 19],
  ['\uFE90', 19],
  ['\uFE91', 19],
  ['\uFE92', 19],
  ['\uFE93', 20],
  ['\uFE94', 20],
  ['\uFE95', 21],
  ['\uFE96', 21],
  ['\uFE97', 21],
  ['\uFE98', 21],
  ['\uFE99', 22],
  ['\uFE9A', 22],
  ['\uFE9B', 22],
  ['\uFE9C', 22],
  ['\uFE9D', 23],
  ['\uFE9E', 23],
  ['\uFE9F', 23],
  ['\uFEA0', 23],
  ['\uFEA1', 24],
  ['\uFEA2', 24],
  ['\uFEA3', 24],
  ['\uFEA4', 24],
  ['\uFEA5', 25],
  ['\uFEA6', 25],
  ['\uFEA7', 25],
  ['\uFEA8', 25],
  ['\uFEA9', 26],
  ['\uFEAA', 26],
  ['\uFEAB', 27],
  ['\uFEAC', 27],
  ['\uFEAD', 28],
  ['\uFEAE', 28],
  ['\uFEAF', 29],
  ['\uFEB0', 29],
  ['\uFEB1', 30],
  ['\uFEB2', 30],
  ['\uFEB3', 30],
  ['\uFEB4', 30],
  ['\uFEB5', 31],
  ['\uFEB6', 31],
  ['\uFEB7', 31],
  ['\uFEB8', 31],
  ['\uFEB9', 32],
  ['\uFEBA', 32],
  ['\uFEBB', 32],
  ['\uFEBC', 32],
  ['\uFEBD', 33],
  ['\uFEBE', 33],
  ['\uFEBF', 33],
  ['\uFEC0', 33],
  ['\uFEC1', 34],
  ['\uFEC2', 34],
  ['\uFEC3', 34],
  ['\uFEC4', 34],
  ['\uFEC5', 35],
  ['\uFEC6', 35],
  ['\uFEC7', 35],
  ['\uFEC8', 35],
  ['\uFEC9', 36],
  ['\uFECA', 36],
  ['\uFECB', 36],
  ['\uFECC', 36],
  ['\uFECD', 37],
  ['\uFECE', 37],
  ['\uFECF', 37],
  ['\uFED0', 37],
  ['\uFED1', 38],
  ['\uFED2', 38],
  ['\uFED3', 38],
  ['\uFED4', 38],
  ['\uFED5', 39],
  ['\uFED6', 39],
  ['\uFED7', 39],
  ['\uFED8', 39],
  ['\uFED9', 40],
  ['\uFEDA', 40],
  ['\uFEDB', 40],
  ['\uFEDC', 40],
  ['\uFEDD', 41],
  ['\uFEDE', 41],
  ['\uFEDF', 41],
  ['\uFEE0', 41],
  ['\uFEE1', 42],
  ['\uFEE2', 42],
  ['\uFEE3', 42],
  ['\uFEE4', 42],
  ['\uFEE5', 43],
  ['\uFEE6', 43],
  ['\uFEE7', 43],
  ['\uFEE8', 43],
  ['\uFEE9', 44],
  ['\uFEEA', 44],
  ['\uFEEB', 44],
  ['\uFEEC', 44],
  ['\uFEED', 45],
  ['\uFEEE', 45],
  ['\uFEEF', 46],
  ['\uFEF0', 46],
  ['\uFEF1', 47],
  ['\uFEF2', 47],
  ['\uFEF3', 47],
  ['\uFEF4', 47],
  ['\uFEF5', 51],
  ['\uFEF6', 51],
  ['\uFEF7', 49],
  ['\uFEF8', 49],
  ['\uFEF9', 50],
  ['\uFEFA', 50],
  ['\uFEFB', 48],
  ['\uFEFC', 48],
]

const as_0: string[] = [
  '',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '\u0621',
  '\u0623',
  '\u0625',
  '\u0626',
  '\u0622',
  '\u0624',
  '\u0627',
  '\u0628',
  '\u0629',
  '\u062A',
  '\u062B',
  '\u062C',
  '\u062D',
  '\u062E',
  '\u062F',
  '\u0630',
  '\u0631',
  '\u0632',
  '\u0633',
  '\u0634',
  '\u0635',
  '\u0636',
  '\u0637',
  '\u0638',
  '\u0639',
  '\u063A',
  '\u0641',
  '\u0642',
  '\u0643',
  '\u0644',
  '\u0645',
  '\u0646',
  '\u0647',
  '\u0648',
  '\u0649',
  '\u064A',
  '\u0644\u0627',
  '\u0644\u0623',
  '\u0644\u0625',
  '\u0644\u0622',
]

const a_1: Among[] = [
  ['\u0622', 1],
  ['\u0623', 1],
  ['\u0624', 1],
  ['\u0625', 1],
  ['\u0626', 1],
]

const a_2: Among[] = [
  ['\u0622', 1],
  ['\u0623', 1],
  ['\u0624', 2],
  ['\u0625', 1],
  ['\u0626', 3],
]

const as_2: string[] = ['\u0627', '\u0648', '\u064A']

const a_3: Among[] = [
  ['\u0627\u0644', 2],
  ['\u0628\u0627\u0644', 1],
  ['\u0643\u0627\u0644', 1],
  ['\u0644\u0644', 2],
]

const a_4: Among[] = [
  ['\u0623\u0622', 2],
  ['\u0623\u0623', 1],
  ['\u0623\u0624', 1],
  ['\u0623\u0625', 4],
  ['\u0623\u0627', 3],
]

const a_5: Among[] = [
  ['\u0641', 1],
  ['\u0648', 1],
]

const a_6: Among[] = [
  ['\u0627\u0644', 2],
  ['\u0628\u0627\u0644', 1],
  ['\u0643\u0627\u0644', 1],
  ['\u0644\u0644', 2],
]

const a_7: Among[] = [
  ['\u0628', 1],
  ['\u0628\u0627', -1, 1],
  ['\u0628\u0628', 2, 2],
  ['\u0643\u0643', 3],
]

const a_8: Among[] = [
  ['\u0633\u0623', 4],
  ['\u0633\u062A', 2],
  ['\u0633\u0646', 3],
  ['\u0633\u064A', 1],
]

const a_9: Among[] = [
  ['\u062A\u0633\u062A', 1],
  ['\u0646\u0633\u062A', 1],
  ['\u064A\u0633\u062A', 1],
]

const a_10: Among[] = [
  ['\u0643\u0645\u0627', 3],
  ['\u0647\u0645\u0627', 3],
  ['\u0646\u0627', 2],
  ['\u0647\u0627', 2],
  ['\u0643', 1],
  ['\u0643\u0645', 2],
  ['\u0647\u0645', 2],
  ['\u0647\u0646', 2],
  ['\u0647', 1],
  ['\u064A', 1],
]

const a_11: Among[] = [
  ['\u0627', 1],
  ['\u0648', 1],
  ['\u064A', 1],
]

const a_12: Among[] = [
  ['\u0643\u0645\u0627', 3],
  ['\u0647\u0645\u0627', 3],
  ['\u0646\u0627', 2],
  ['\u0647\u0627', 2],
  ['\u0643', 1],
  ['\u0643\u0645', 2],
  ['\u0647\u0645', 2],
  ['\u0643\u0646', 2],
  ['\u0647\u0646', 2],
  ['\u0647', 1],
  ['\u0643\u0645\u0648', 3],
  ['\u0646\u064A', 2],
]

const a_13: Among[] = [
  ['\u0627', 1],
  ['\u062A\u0627', 2, 1],
  ['\u062A\u0645\u0627', 3, 2],
  ['\u0646\u0627', 2, 3],
  ['\u062A', 1],
  ['\u0646', 1],
  ['\u0627\u0646', 3, 1],
  ['\u062A\u0646', 2, 2],
  ['\u0648\u0646', 3, 3],
  ['\u064A\u0646', 3, 4],
  ['\u064A', 1],
]

const a_14: Among[] = [
  ['\u0648\u0627', 1],
  ['\u062A\u0645', 1],
]

const a_15: Among[] = [
  ['\u0648', 1],
  ['\u062A\u0645\u0648', 2, 1],
]

export class ArabicStemmer extends BaseStemmer {
  #r_Suffix_Noun_Step2a(): boolean {
    this.ket = this.c
    if (this.find_among_b(a_11) === 0) return false
    this.bra = this.c
    if (/**@type {boolean}*/ (this.current.length < 5)) return false
    this.slice_del()
    return true
  }

  #r_Suffix_Noun_Step2b(): boolean {
    this.ket = this.c
    if (!this.eq_s_b('\u0627\u062A')) return false
    this.bra = this.c
    if (/**@type {boolean}*/ (this.current.length < 5)) return false
    this.slice_del()
    return true
  }

  #r_Suffix_Noun_Step2c1(): boolean {
    this.ket = this.c
    if (!this.eq_s_b('\u062A')) return false
    this.bra = this.c
    if (/**@type {boolean}*/ (this.current.length < 4)) return false
    this.slice_del()
    return true
  }

  #r_Suffix_Verb_Step2a(): boolean {
    let a: number
    this.ket = this.c
    a = this.find_among_b(a_13)
    if (a === 0) return false
    this.bra = this.c
    switch (a) {
      case 1: {
        if (/**@type {boolean}*/ (this.current.length < 4)) return false
        this.slice_del()
        break
      }
      case 2: {
        if (/**@type {boolean}*/ (this.current.length < 5)) return false
        this.slice_del()
        break
      }
      case 3: {
        if (/**@type {boolean}*/ (this.current.length < 6)) return false
        this.slice_del()
        break
      }
    }
    return true
  }

  #stem(): boolean {
    let a: number
    let B_is_defined: boolean
    let B_is_verb: boolean
    let B_is_noun: boolean
    B_is_noun = true
    B_is_verb = true
    B_is_defined = false
    const v_1: number = this.c
    lab0: {
      this.bra = this.c
      a = this.find_among(a_3)
      if (a === 0) break lab0
      this.ket = this.c
      switch (a) {
        case 1: {
          if (/**@type {boolean}*/ (this.current.length < 5)) break lab0
          B_is_noun = true
          B_is_verb = false
          B_is_defined = true
          break
        }
        case 2: {
          if (/**@type {boolean}*/ (this.current.length < 4)) break lab0
          B_is_noun = true
          B_is_verb = false
          B_is_defined = true
          break
        }
      }
    }
    this.c = v_1
    {
      const v_2: number = this.c
      while (true) {
        const v_3: number = this.c
        lab3: {
          lab4: {
            const v_4: number = this.c
            lab5: {
              this.bra = this.c
              a = this.find_among(a_0)
              if (a === 0) break lab5
              this.ket = this.c
              this.slice_from(as_0[a - 1])
              break lab4
            }
            this.c = v_4
            if (this.c >= this.limit) break lab3
            this.c++
          }
          continue
        }
        this.c = v_3
        break
      }
      this.c = v_2
    }
    this.limit_backward = this.c
    this.c = this.limit
    const v_5: number = this.limit - this.c
    lab6: {
      lab7: {
        const v_6: number = this.limit - this.c
        lab8: {
          if (!B_is_verb) break lab8
          lab9: {
            const v_7: number = this.limit - this.c
            lab10: {
              {
                let v_8 = 1
                while (true) {
                  const v_9: number = this.limit - this.c
                  lab11: {
                    this.ket = this.c
                    a = this.find_among_b(a_12)
                    if (a === 0) break lab11
                    this.bra = this.c
                    switch (a) {
                      case 1: {
                        if (/**@type {boolean}*/ (this.current.length < 4)) break lab11
                        this.slice_del()
                        break
                      }
                      case 2: {
                        if (/**@type {boolean}*/ (this.current.length < 5)) break lab11
                        this.slice_del()
                        break
                      }
                      case 3: {
                        if (/**@type {boolean}*/ (this.current.length < 6)) break lab11
                        this.slice_del()
                        break
                      }
                    }
                    v_8--
                    continue
                  }
                  this.c = this.limit - v_9
                  break
                }
                if (v_8 > 0) break lab10
              }
              lab12: {
                const v_10: number = this.limit - this.c
                lab13: {
                  if (!this.#r_Suffix_Verb_Step2a()) break lab13
                  break lab12
                }
                this.c = this.limit - v_10
                lab14: {
                  this.ket = this.c
                  a = this.find_among_b(a_15)
                  if (a === 0) break lab14
                  this.bra = this.c
                  switch (a) {
                    case 1: {
                      if (/**@type {boolean}*/ (this.current.length < 4)) break lab14
                      this.slice_del()
                      break
                    }
                    case 2: {
                      if (/**@type {boolean}*/ (this.current.length < 6)) break lab14
                      this.slice_del()
                      break
                    }
                  }
                  break lab12
                }
                this.c = this.limit - v_10
                if (this.c <= this.limit_backward) break lab10
                this.c--
              }
              break lab9
            }
            this.c = this.limit - v_7
            lab15: {
              this.ket = this.c
              if (this.find_among_b(a_14) === 0) break lab15
              this.bra = this.c
              if (/**@type {boolean}*/ (this.current.length < 5)) break lab15
              this.slice_del()
              break lab9
            }
            this.c = this.limit - v_7
            if (!this.#r_Suffix_Verb_Step2a()) break lab8
          }
          break lab7
        }
        this.c = this.limit - v_6
        lab16: {
          if (!B_is_noun) break lab16
          const v_11: number = this.limit - this.c
          lab17: {
            lab18: {
              const v_12: number = this.limit - this.c
              lab19: {
                this.ket = this.c
                if (!this.eq_s_b('\u0629')) break lab19
                this.bra = this.c
                if (/**@type {boolean}*/ (this.current.length < 4)) break lab19
                this.slice_del()
                break lab18
              }
              this.c = this.limit - v_12
              lab20: {
                if (B_is_defined) break lab20
                this.ket = this.c
                a = this.find_among_b(a_10)
                if (a === 0) break lab20
                this.bra = this.c
                switch (a) {
                  case 1: {
                    if (/**@type {boolean}*/ (this.current.length < 4)) break lab20
                    this.slice_del()
                    break
                  }
                  case 2: {
                    if (/**@type {boolean}*/ (this.current.length < 5)) break lab20
                    this.slice_del()
                    break
                  }
                  case 3: {
                    if (/**@type {boolean}*/ (this.current.length < 6)) break lab20
                    this.slice_del()
                    break
                  }
                }
                lab21: {
                  const v_13: number = this.limit - this.c
                  lab22: {
                    if (!this.#r_Suffix_Noun_Step2a()) break lab22
                    break lab21
                  }
                  this.c = this.limit - v_13
                  lab23: {
                    if (!this.#r_Suffix_Noun_Step2b()) break lab23
                    break lab21
                  }
                  this.c = this.limit - v_13
                  lab24: {
                    if (!this.#r_Suffix_Noun_Step2c1()) break lab24
                    break lab21
                  }
                  this.c = this.limit - v_13
                  if (this.c <= this.limit_backward) break lab20
                  this.c--
                }
                break lab18
              }
              this.c = this.limit - v_12
              lab25: {
                this.ket = this.c
                if (!this.eq_s_b('\u0646')) break lab25
                this.bra = this.c
                if (/**@type {boolean}*/ (this.current.length < 6)) break lab25
                this.slice_del()
                lab26: {
                  const v_14: number = this.limit - this.c
                  lab27: {
                    if (!this.#r_Suffix_Noun_Step2a()) break lab27
                    break lab26
                  }
                  this.c = this.limit - v_14
                  lab28: {
                    if (!this.#r_Suffix_Noun_Step2b()) break lab28
                    break lab26
                  }
                  this.c = this.limit - v_14
                  if (!this.#r_Suffix_Noun_Step2c1()) break lab25
                }
                break lab18
              }
              this.c = this.limit - v_12
              lab29: {
                if (B_is_defined) break lab29
                if (!this.#r_Suffix_Noun_Step2a()) break lab29
                break lab18
              }
              this.c = this.limit - v_12
              if (!this.#r_Suffix_Noun_Step2b()) {
                this.c = this.limit - v_11
                break lab17
              }
            }
          }
          this.ket = this.c
          if (!this.eq_s_b('\u064A')) break lab16
          this.bra = this.c
          if (/**@type {boolean}*/ (this.current.length < 3)) break lab16
          this.slice_del()
          break lab7
        }
        this.c = this.limit - v_6
        this.ket = this.c
        if (!this.eq_s_b('\u0649')) break lab6
        this.bra = this.c
        this.slice_from('\u064A')
      }
    }
    this.c = this.limit - v_5
    this.c = this.limit_backward
    const v_15: number = this.c
    lab30: {
      const v_16: number = this.c
      lab31: {
        this.bra = this.c
        a = this.find_among(a_4)
        if (a === 0) {
          this.c = v_16
          break lab31
        }
        this.ket = this.c
        switch (a) {
          case 1: {
            if (/**@type {boolean}*/ (this.current.length < 4)) {
              this.c = v_16
              break lab31
            }
            this.slice_from('\u0623')
            break
          }
          case 2: {
            if (/**@type {boolean}*/ (this.current.length < 4)) {
              this.c = v_16
              break lab31
            }
            this.slice_from('\u0622')
            break
          }
          case 3: {
            if (/**@type {boolean}*/ (this.current.length < 4)) {
              this.c = v_16
              break lab31
            }
            this.slice_from('\u0627')
            break
          }
          case 4: {
            if (/**@type {boolean}*/ (this.current.length < 4)) {
              this.c = v_16
              break lab31
            }
            this.slice_from('\u0625')
            break
          }
        }
      }
      const v_17: number = this.c
      lab32: {
        this.bra = this.c
        if (this.find_among(a_5) === 0) {
          this.c = v_17
          break lab32
        }
        this.ket = this.c
        if (/**@type {boolean}*/ (this.current.length < 4)) {
          this.c = v_17
          break lab32
        }
        lab33: {
          if (!this.eq_s('\u0627')) break lab33
          this.c = v_17
          break lab32
        }
        this.slice_del()
      }
      lab34: {
        const v_18: number = this.c
        lab35: {
          this.bra = this.c
          a = this.find_among(a_6)
          if (a === 0) break lab35
          this.ket = this.c
          switch (a) {
            case 1: {
              if (/**@type {boolean}*/ (this.current.length < 6)) break lab35
              this.slice_del()
              break
            }
            case 2: {
              if (/**@type {boolean}*/ (this.current.length < 5)) break lab35
              this.slice_del()
              break
            }
          }
          break lab34
        }
        this.c = v_18
        lab36: {
          if (!B_is_noun) break lab36
          this.bra = this.c
          a = this.find_among(a_7)
          if (a === 0) break lab36
          this.ket = this.c
          switch (a) {
            case 1: {
              if (/**@type {boolean}*/ (this.current.length < 4)) break lab36
              this.slice_del()
              break
            }
            case 2: {
              if (/**@type {boolean}*/ (this.current.length < 4)) break lab36
              this.slice_from('\u0628')
              break
            }
            case 3: {
              if (/**@type {boolean}*/ (this.current.length < 4)) break lab36
              this.slice_from('\u0643')
              break
            }
          }
          break lab34
        }
        this.c = v_18
        if (!B_is_verb) break lab30
        const v_19: number = this.c
        lab37: {
          this.bra = this.c
          a = this.find_among(a_8)
          if (a === 0) {
            this.c = v_19
            break lab37
          }
          this.ket = this.c
          switch (a) {
            case 1: {
              if (/**@type {boolean}*/ (this.current.length < 5)) {
                this.c = v_19
                break lab37
              }
              this.slice_from('\u064A')
              break
            }
            case 2: {
              if (/**@type {boolean}*/ (this.current.length < 5)) {
                this.c = v_19
                break lab37
              }
              this.slice_from('\u062A')
              break
            }
            case 3: {
              if (/**@type {boolean}*/ (this.current.length < 5)) {
                this.c = v_19
                break lab37
              }
              this.slice_from('\u0646')
              break
            }
            case 4: {
              if (/**@type {boolean}*/ (this.current.length < 5)) {
                this.c = v_19
                break lab37
              }
              this.slice_from('\u0623')
              break
            }
          }
        }
        this.bra = this.c
        if (this.find_among(a_9) === 0) break lab30
        this.ket = this.c
        if (/**@type {boolean}*/ (this.current.length < 5)) break lab30
        B_is_verb = true
        B_is_noun = false
        this.slice_from('\u0627\u0633\u062A')
      }
    }
    this.c = v_15
    {
      const v_20: number = this.c
      lab39: {
        this.limit_backward = this.c
        this.c = this.limit
        this.ket = this.c
        if (this.find_among_b(a_1) === 0) break lab39
        this.bra = this.c
        this.slice_from('\u0621')
        this.c = this.limit_backward
      }
      this.c = v_20
      const v_21: number = this.c
      while (true) {
        const v_22: number = this.c
        lab41: {
          lab42: {
            const v_23: number = this.c
            lab43: {
              this.bra = this.c
              a = this.find_among(a_2)
              if (a === 0) break lab43
              this.ket = this.c
              this.slice_from(as_2[a - 1])
              break lab42
            }
            this.c = v_23
            if (this.c >= this.limit) break lab41
            this.c++
          }
          continue
        }
        this.c = v_22
        break
      }
      this.c = v_21
    }
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new ArabicStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'd9b491d016b4caf6'
