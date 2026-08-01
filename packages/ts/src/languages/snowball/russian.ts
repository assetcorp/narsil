/*
 * Generated from algorithms/russian.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 87767119dd36215c
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['\u0432', 1],
  ['\u0438\u0432', 2, 1],
  ['\u044B\u0432', 2, 2],
  ['\u0432\u0448\u0438', 1],
  ['\u0438\u0432\u0448\u0438', 2, 1],
  ['\u044B\u0432\u0448\u0438', 2, 2],
  ['\u0432\u0448\u0438\u0441\u044C', 1],
  ['\u0438\u0432\u0448\u0438\u0441\u044C', 2, 1],
  ['\u044B\u0432\u0448\u0438\u0441\u044C', 2, 2],
]

const a_1: Among[] = [
  ['\u0435\u0435', 1],
  ['\u0438\u0435', 1],
  ['\u043E\u0435', 1],
  ['\u044B\u0435', 1],
  ['\u0438\u043C\u0438', 1],
  ['\u044B\u043C\u0438', 1],
  ['\u0435\u0439', 1],
  ['\u0438\u0439', 1],
  ['\u043E\u0439', 1],
  ['\u044B\u0439', 1],
  ['\u0435\u043C', 1],
  ['\u0438\u043C', 1],
  ['\u043E\u043C', 1],
  ['\u044B\u043C', 1],
  ['\u0435\u0433\u043E', 1],
  ['\u043E\u0433\u043E', 1],
  ['\u0435\u043C\u0443', 1],
  ['\u043E\u043C\u0443', 1],
  ['\u0438\u0445', 1],
  ['\u044B\u0445', 1],
  ['\u0435\u044E', 1],
  ['\u043E\u044E', 1],
  ['\u0443\u044E', 1],
  ['\u044E\u044E', 1],
  ['\u0430\u044F', 1],
  ['\u044F\u044F', 1],
]

const a_2: Among[] = [
  ['\u0435\u043C', 1],
  ['\u043D\u043D', 1],
  ['\u0432\u0448', 1],
  ['\u0438\u0432\u0448', 2, 1],
  ['\u044B\u0432\u0448', 2, 2],
  ['\u0449', 1],
  ['\u044E\u0449', 1, 1],
  ['\u0443\u044E\u0449', 2, 1],
]

const a_3: Among[] = [
  ['\u0441\u044C', 1],
  ['\u0441\u044F', 1],
]

const a_4: Among[] = [
  ['\u043B\u0430', 1],
  ['\u0438\u043B\u0430', 2, 1],
  ['\u044B\u043B\u0430', 2, 2],
  ['\u043D\u0430', 1],
  ['\u0435\u043D\u0430', 2, 1],
  ['\u0435\u0442\u0435', 1],
  ['\u0438\u0442\u0435', 2],
  ['\u0439\u0442\u0435', 1],
  ['\u0435\u0439\u0442\u0435', 2, 1],
  ['\u0443\u0439\u0442\u0435', 2, 2],
  ['\u043B\u0438', 1],
  ['\u0438\u043B\u0438', 2, 1],
  ['\u044B\u043B\u0438', 2, 2],
  ['\u0439', 1],
  ['\u0435\u0439', 2, 1],
  ['\u0443\u0439', 2, 2],
  ['\u043B', 1],
  ['\u0438\u043B', 2, 1],
  ['\u044B\u043B', 2, 2],
  ['\u0435\u043C', 1],
  ['\u0438\u043C', 2],
  ['\u044B\u043C', 2],
  ['\u043D', 1],
  ['\u0435\u043D', 2, 1],
  ['\u043B\u043E', 1],
  ['\u0438\u043B\u043E', 2, 1],
  ['\u044B\u043B\u043E', 2, 2],
  ['\u043D\u043E', 1],
  ['\u0435\u043D\u043E', 2, 1],
  ['\u043D\u043D\u043E', 1, 2],
  ['\u0435\u0442', 1],
  ['\u0443\u0435\u0442', 2, 1],
  ['\u0438\u0442', 2],
  ['\u044B\u0442', 2],
  ['\u044E\u0442', 1],
  ['\u0443\u044E\u0442', 2, 1],
  ['\u044F\u0442', 2],
  ['\u043D\u044B', 1],
  ['\u0435\u043D\u044B', 2, 1],
  ['\u0442\u044C', 1],
  ['\u0438\u0442\u044C', 2, 1],
  ['\u044B\u0442\u044C', 2, 2],
  ['\u0435\u0448\u044C', 1],
  ['\u0438\u0448\u044C', 2],
  ['\u044E', 2],
  ['\u0443\u044E', 2, 1],
]

const a_5: Among[] = [
  ['\u0430', 1],
  ['\u0435\u0432', 1],
  ['\u043E\u0432', 1],
  ['\u0435', 1],
  ['\u0438\u0435', 1, 1],
  ['\u044C\u0435', 1, 2],
  ['\u0438', 1],
  ['\u0435\u0438', 1, 1],
  ['\u0438\u0438', 1, 2],
  ['\u0430\u043C\u0438', 1, 3],
  ['\u044F\u043C\u0438', 1, 4],
  ['\u0438\u044F\u043C\u0438', 1, 1],
  ['\u0439', 1],
  ['\u0435\u0439', 1, 1],
  ['\u0438\u0435\u0439', 1, 1],
  ['\u0438\u0439', 1, 3],
  ['\u043E\u0439', 1, 4],
  ['\u0430\u043C', 1],
  ['\u0435\u043C', 1],
  ['\u0438\u0435\u043C', 1, 1],
  ['\u043E\u043C', 1],
  ['\u044F\u043C', 1],
  ['\u0438\u044F\u043C', 1, 1],
  ['\u043E', 1],
  ['\u0443', 1],
  ['\u0430\u0445', 1],
  ['\u044F\u0445', 1],
  ['\u0438\u044F\u0445', 1, 1],
  ['\u044B', 1],
  ['\u044C', 1],
  ['\u044E', 1],
  ['\u0438\u044E', 1, 1],
  ['\u044C\u044E', 1, 2],
  ['\u044F', 1],
  ['\u0438\u044F', 1, 1],
  ['\u044C\u044F', 1, 2],
]

const a_6: Among[] = [
  ['\u043E\u0441\u0442', 1],
  ['\u043E\u0441\u0442\u044C', 1],
]

const a_7: Among[] = [
  ['\u0435\u0439\u0448\u0435', 1],
  ['\u043D', 2],
  ['\u0435\u0439\u0448', 1],
  ['\u044C', 3],
]

const g_v: number[] = [33, 65, 8, 232]

export class RussianStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let I_p2: number
    let I_pV: number
    const v_1: number = this.c
    while (true) {
      const v_2: number = this.c
      lab1: {
        while (true) {
          const v_3: number = this.c
          lab3: {
            this.bra = this.c
            if (!this.eq_s('\u0451')) break lab3
            this.ket = this.c
            this.c = v_3
            break
          }
          this.c = v_3
          if (this.c >= this.limit) break lab1
          this.c++
        }
        this.slice_from('\u0435')
        continue
      }
      this.c = v_2
      break
    }
    this.c = v_1
    {
      I_pV = this.limit
      I_p2 = this.limit
      const v_4: number = this.c
      lab5: {
        if (!this.go_out_grouping(g_v, 1072, 1103)) break lab5
        this.c++
        I_pV = this.c
        if (!this.go_in_grouping(g_v, 1072, 1103)) break lab5
        this.c++
        if (!this.go_out_grouping(g_v, 1072, 1103)) break lab5
        this.c++
        if (!this.go_in_grouping(g_v, 1072, 1103)) break lab5
        this.c++
        I_p2 = this.c
      }
      this.c = v_4
    }
    this.limit_backward = this.c
    this.c = this.limit
    if (this.c < I_pV) return false
    const v_5: number = this.limit_backward
    this.limit_backward = I_pV
    const v_6: number = this.limit - this.c
    lab6: {
      lab7: {
        const v_7: number = this.limit - this.c
        lab8: {
          this.ket = this.c
          a = this.find_among_b(a_0)
          if (a === 0) break lab8
          this.bra = this.c
          switch (a) {
            case 1: {
              lab9: {
                lab10: {
                  if (!this.eq_s_b('\u0430')) break lab10
                  break lab9
                }
                if (!this.eq_s_b('\u044F')) break lab8
              }
              this.slice_del()
              break
            }
            case 2: {
              this.slice_del()
              break
            }
          }
          break lab7
        }
        this.c = this.limit - v_7
        const v_8: number = this.limit - this.c
        lab11: {
          this.ket = this.c
          if (this.find_among_b(a_3) === 0) {
            this.c = this.limit - v_8
            break lab11
          }
          this.bra = this.c
          this.slice_del()
        }
        lab12: {
          const v_9: number = this.limit - this.c
          lab13: {
            this.ket = this.c
            if (this.find_among_b(a_1) === 0) break lab13
            this.bra = this.c
            this.slice_del()
            const v_10: number = this.limit - this.c
            lab14: {
              this.ket = this.c
              a = this.find_among_b(a_2)
              if (a === 0) {
                this.c = this.limit - v_10
                break lab14
              }
              this.bra = this.c
              switch (a) {
                case 1: {
                  lab15: {
                    lab16: {
                      if (!this.eq_s_b('\u0430')) break lab16
                      break lab15
                    }
                    if (!this.eq_s_b('\u044F')) {
                      this.c = this.limit - v_10
                      break lab14
                    }
                  }
                  this.slice_del()
                  break
                }
                case 2: {
                  this.slice_del()
                  break
                }
              }
            }
            break lab12
          }
          this.c = this.limit - v_9
          lab17: {
            this.ket = this.c
            a = this.find_among_b(a_4)
            if (a === 0) break lab17
            this.bra = this.c
            switch (a) {
              case 1: {
                lab18: {
                  lab19: {
                    if (!this.eq_s_b('\u0430')) break lab19
                    break lab18
                  }
                  if (!this.eq_s_b('\u044F')) break lab17
                }
                this.slice_del()
                break
              }
              case 2: {
                this.slice_del()
                break
              }
            }
            break lab12
          }
          this.c = this.limit - v_9
          this.ket = this.c
          if (this.find_among_b(a_5) === 0) break lab6
          this.bra = this.c
          this.slice_del()
        }
      }
    }
    this.c = this.limit - v_6
    const v_11: number = this.limit - this.c
    lab20: {
      this.ket = this.c
      if (!this.eq_s_b('\u0438')) {
        this.c = this.limit - v_11
        break lab20
      }
      this.bra = this.c
      this.slice_del()
    }
    const v_12: number = this.limit - this.c
    lab21: {
      this.ket = this.c
      if (this.find_among_b(a_6) === 0) break lab21
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
      this.slice_del()
    }
    this.c = this.limit - v_12
    const v_13: number = this.limit - this.c
    lab22: {
      this.ket = this.c
      a = this.find_among_b(a_7)
      if (a === 0) break lab22
      this.bra = this.c
      switch (a) {
        case 1: {
          this.slice_del()
          this.ket = this.c
          if (!this.eq_s_b('\u043D')) break lab22
          this.bra = this.c
          if (!this.eq_s_b('\u043D')) break lab22
          this.slice_del()
          break
        }
        case 2: {
          if (!this.eq_s_b('\u043D')) break lab22
          this.slice_del()
          break
        }
        case 3: {
          this.slice_del()
          break
        }
      }
    }
    this.c = this.limit - v_13
    this.limit_backward = v_5
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new RussianStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '87767119dd36215c'
