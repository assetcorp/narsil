/*
 * Generated from algorithms/tamil.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision f859bf3d19447fbc
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['\u0BB5\u0BC1', 3],
  ['\u0BB5\u0BC2', 4],
  ['\u0BB5\u0BCA', 2],
  ['\u0BB5\u0BCB', 1],
]

const as_0: string[] = ['\u0B93', '\u0B92', '\u0B89', '\u0B8A']

const a_1: Among[] = [
  ['\u0B95', -1],
  ['\u0B99', -1],
  ['\u0B9A', -1],
  ['\u0B9E', -1],
  ['\u0BA4', -1],
  ['\u0BA8', -1],
  ['\u0BAA', -1],
  ['\u0BAE', -1],
  ['\u0BAF', -1],
  ['\u0BB5', -1],
]

const a_2: Among[] = [
  ['\u0BBF', -1],
  ['\u0BC0', -1],
  ['\u0BC8', -1],
]

const a_3: Among[] = [
  ['\u0BBE', -1],
  ['\u0BBF', -1],
  ['\u0BC0', -1],
  ['\u0BC1', -1],
  ['\u0BC2', -1],
  ['\u0BC6', -1],
  ['\u0BC7', -1],
  ['\u0BC8', -1],
]

const a_4: Among[] = [
  ['', 2],
  ['\u0BC8', 1, 1],
  ['\u0BCD', 1, 2],
]

const as_4: string[] = ['', '\u0BAE\u0BCD']

const a_5: Among[] = [
  ['\u0BA8\u0BCD\u0BA4', 1],
  ['\u0BAF', 1],
  ['\u0BB5', 1],
  ['\u0BA9\u0BC1', 8],
  ['\u0BC1\u0B95\u0BCD', 7],
  ['\u0BC1\u0B95\u0BCD\u0B95\u0BCD', 7],
  ['\u0B9F\u0BCD\u0B95\u0BCD', 3],
  ['\u0BB1\u0BCD\u0B95\u0BCD', 4],
  ['\u0B99\u0BCD', 9],
  ['\u0B9F\u0BCD\u0B9F\u0BCD', 5],
  ['\u0BA4\u0BCD\u0BA4\u0BCD', 6],
  ['\u0BA8\u0BCD\u0BA4\u0BCD', 1],
  ['\u0BA8\u0BCD', 1],
  ['\u0B9F\u0BCD\u0BAA\u0BCD', 3],
  ['\u0BAF\u0BCD', 2],
  ['\u0BA9\u0BCD\u0BB1\u0BCD', 4],
  ['\u0BB5\u0BCD', 1],
]

const a_6: Among[] = [
  ['\u0B95', -1],
  ['\u0B9A', -1],
  ['\u0B9F', -1],
  ['\u0BA4', -1],
  ['\u0BAA', -1],
  ['\u0BB1', -1],
]

const a_7: Among[] = [
  ['\u0B95', -1],
  ['\u0B9A', -1],
  ['\u0B9F', -1],
  ['\u0BA4', -1],
  ['\u0BAA', -1],
  ['\u0BB1', -1],
]

const a_8: Among[] = [
  ['\u0B9E', -1],
  ['\u0BA3', -1],
  ['\u0BA8', -1],
  ['\u0BA9', -1],
  ['\u0BAE', -1],
  ['\u0BAF', -1],
  ['\u0BB0', -1],
  ['\u0BB2', -1],
  ['\u0BB3', -1],
  ['\u0BB4', -1],
  ['\u0BB5', -1],
]

const a_9: Among[] = [
  ['\u0BBE', -1],
  ['\u0BBF', -1],
  ['\u0BC0', -1],
  ['\u0BC1', -1],
  ['\u0BC2', -1],
  ['\u0BC6', -1],
  ['\u0BC7', -1],
  ['\u0BC8', -1],
  ['\u0BCD', -1],
]

const a_10: Among[] = [
  ['\u0B85', -1],
  ['\u0B87', -1],
  ['\u0B89', -1],
]

const a_11: Among[] = [
  ['\u0B95', -1],
  ['\u0B99', -1],
  ['\u0B9A', -1],
  ['\u0B9E', -1],
  ['\u0BA4', -1],
  ['\u0BA8', -1],
  ['\u0BAA', -1],
  ['\u0BAE', -1],
  ['\u0BAF', -1],
  ['\u0BB5', -1],
]

const a_12: Among[] = [
  ['\u0B95', -1],
  ['\u0B9A', -1],
  ['\u0B9F', -1],
  ['\u0BA4', -1],
  ['\u0BAA', -1],
  ['\u0BB1', -1],
]

const a_13: Among[] = [
  ['\u0B95\u0BB3\u0BCD', 4],
  ['\u0BC1\u0B99\u0BCD\u0B95\u0BB3\u0BCD', 1, 1],
  ['\u0B9F\u0BCD\u0B95\u0BB3\u0BCD', 3, 2],
  ['\u0BB1\u0BCD\u0B95\u0BB3\u0BCD', 2, 3],
]

const a_14: Among[] = [
  ['\u0BBE', -1],
  ['\u0BC7', -1],
  ['\u0BCB', -1],
]

const a_15: Among[] = [
  ['\u0BAA\u0BBF', -1],
  ['\u0BB5\u0BBF', -1],
]

const a_16: Among[] = [
  ['\u0BBE', -1],
  ['\u0BBF', -1],
  ['\u0BC0', -1],
  ['\u0BC1', -1],
  ['\u0BC2', -1],
  ['\u0BC6', -1],
  ['\u0BC7', -1],
  ['\u0BC8', -1],
]

const a_17: Among[] = [
  ['\u0BAA\u0B9F\u0BCD\u0B9F', 3],
  ['\u0BAA\u0B9F\u0BCD\u0B9F\u0BA3', 3],
  ['\u0BA4\u0BBE\u0BA9', 3],
  ['\u0BAA\u0B9F\u0BBF\u0BA4\u0BBE\u0BA9', 3, 1],
  ['\u0BC6\u0BA9', 1],
  ['\u0BBE\u0B95\u0BBF\u0BAF', 1],
  ['\u0B95\u0BC1\u0BB0\u0BBF\u0BAF', 3],
  ['\u0BC1\u0B9F\u0BC8\u0BAF', 1],
  ['\u0BB2\u0BCD\u0BB2', 2],
  ['\u0BC1\u0BB3\u0BCD\u0BB3', 1],
  ['\u0BBE\u0B95\u0BBF', 1],
  ['\u0BAA\u0B9F\u0BBF', 3],
  ['\u0BBF\u0BA9\u0BCD\u0BB1\u0BBF', 1],
  ['\u0BAA\u0BB1\u0BCD\u0BB1\u0BBF', 3],
  ['\u0BAA\u0B9F\u0BC1', 3],
  ['\u0BB5\u0BBF\u0B9F\u0BC1', 3],
  ['\u0BAA\u0B9F\u0BCD\u0B9F\u0BC1', 3],
  ['\u0BB5\u0BBF\u0B9F\u0BCD\u0B9F\u0BC1', 3],
  ['\u0BAA\u0B9F\u0BCD\u0B9F\u0BA4\u0BC1', 3],
  ['\u0BC6\u0BA9\u0BCD\u0BB1\u0BC1', 1],
  ['\u0BC1\u0B9F\u0BC8', 1],
  ['\u0BBF\u0BB2\u0BCD\u0BB2\u0BC8', 1],
  ['\u0BC1\u0B9F\u0BA9\u0BCD', 1],
  ['\u0BBF\u0B9F\u0BAE\u0BCD', 1],
  ['\u0BC6\u0BB2\u0BCD\u0BB2\u0BBE\u0BAE\u0BCD', 3],
  ['\u0BC6\u0BA9\u0BC1\u0BAE\u0BCD', 1],
]

const a_18: Among[] = [
  ['\u0BBE', -1],
  ['\u0BBF', -1],
  ['\u0BC0', -1],
  ['\u0BC1', -1],
  ['\u0BC2', -1],
  ['\u0BC6', -1],
  ['\u0BC7', -1],
  ['\u0BC8', -1],
]

const a_19: Among[] = [
  ['\u0BBE', -1],
  ['\u0BBF', -1],
  ['\u0BC0', -1],
  ['\u0BC1', -1],
  ['\u0BC2', -1],
  ['\u0BC6', -1],
  ['\u0BC7', -1],
  ['\u0BC8', -1],
]

const a_20: Among[] = [
  ['\u0BB5\u0BBF\u0B9F', 2],
  ['\u0BC0', 7],
  ['\u0BCA\u0B9F\u0BC1', 2],
  ['\u0BCB\u0B9F\u0BC1', 2],
  ['\u0BA4\u0BC1', 6],
  ['\u0BBF\u0BB0\u0BC1\u0BA8\u0BCD\u0BA4\u0BC1', 2, 1],
  ['\u0BBF\u0BA9\u0BCD\u0BB1\u0BC1', 2],
  ['\u0BC1\u0B9F\u0BC8', 2],
  ['\u0BA9\u0BC8', 1],
  ['\u0B95\u0BA3\u0BCD', 1],
  ['\u0BBF\u0BA9\u0BCD', 3],
  ['\u0BAE\u0BC1\u0BA9\u0BCD', 1],
  ['\u0BBF\u0B9F\u0BAE\u0BCD', 4],
  ['\u0BBF\u0BB1\u0BCD', 2],
  ['\u0BAE\u0BC7\u0BB1\u0BCD', 1],
  ['\u0BB2\u0BCD', 5],
  ['\u0BBE\u0BAE\u0BB2\u0BCD', 2, 1],
  ['\u0BBE\u0BB2\u0BCD', 2, 2],
  ['\u0BBF\u0BB2\u0BCD', 2, 3],
  ['\u0BAE\u0BC7\u0BB2\u0BCD', 1, 4],
  ['\u0BC1\u0BB3\u0BCD', 2],
  ['\u0B95\u0BC0\u0BB4\u0BCD', 1],
]

const a_21: Among[] = [
  ['\u0B95', -1],
  ['\u0B9A', -1],
  ['\u0B9F', -1],
  ['\u0BA4', -1],
  ['\u0BAA', -1],
  ['\u0BB1', -1],
]

const a_22: Among[] = [
  ['\u0B95', -1],
  ['\u0B9A', -1],
  ['\u0B9F', -1],
  ['\u0BA4', -1],
  ['\u0BAA', -1],
  ['\u0BB1', -1],
]

const a_23: Among[] = [
  ['\u0B85', -1],
  ['\u0B86', -1],
  ['\u0B87', -1],
  ['\u0B88', -1],
  ['\u0B89', -1],
  ['\u0B8A', -1],
  ['\u0B8E', -1],
  ['\u0B8F', -1],
  ['\u0B90', -1],
  ['\u0B92', -1],
  ['\u0B93', -1],
  ['\u0B94', -1],
]

const a_24: Among[] = [
  ['\u0BBE', -1],
  ['\u0BBF', -1],
  ['\u0BC0', -1],
  ['\u0BC1', -1],
  ['\u0BC2', -1],
  ['\u0BC6', -1],
  ['\u0BC7', -1],
  ['\u0BC8', -1],
]

const a_25: Among[] = [
  ['\u0B95', 1],
  ['\u0BA4', 1],
  ['\u0BA9', 1],
  ['\u0BAA', 1],
  ['\u0BAF', 1],
  ['\u0BBE', 5],
  ['\u0B95\u0BC1', 6],
  ['\u0BAA\u0B9F\u0BC1', 1],
  ['\u0BA4\u0BC1', 3],
  ['\u0BBF\u0BB1\u0BCD\u0BB1\u0BC1', 1],
  ['\u0BA9\u0BC8', 1],
  ['\u0BB5\u0BC8', 1],
  ['\u0BA9\u0BA9\u0BCD', 1],
  ['\u0BAA\u0BA9\u0BCD', 1],
  ['\u0BB5\u0BA9\u0BCD', 2],
  ['\u0BBE\u0BA9\u0BCD', 4],
  ['\u0BA9\u0BBE\u0BA9\u0BCD', 1, 1],
  ['\u0BAE\u0BBF\u0BA9\u0BCD', 1],
  ['\u0BA9\u0BC6\u0BA9\u0BCD', 1],
  ['\u0BC7\u0BA9\u0BCD', 5],
  ['\u0BA9\u0BAE\u0BCD', 1],
  ['\u0BAA\u0BAE\u0BCD', 1],
  ['\u0BBE\u0BAE\u0BCD', 5],
  ['\u0B95\u0BC1\u0BAE\u0BCD', 1],
  ['\u0B9F\u0BC1\u0BAE\u0BCD', 5],
  ['\u0BA4\u0BC1\u0BAE\u0BCD', 1],
  ['\u0BB1\u0BC1\u0BAE\u0BCD', 1],
  ['\u0BC6\u0BAE\u0BCD', 5],
  ['\u0BC7\u0BAE\u0BCD', 5],
  ['\u0BCB\u0BAE\u0BCD', 5],
  ['\u0BBE\u0BAF\u0BCD', 5],
  ['\u0BA9\u0BB0\u0BCD', 1],
  ['\u0BAA\u0BB0\u0BCD', 1],
  ['\u0BC0\u0BAF\u0BB0\u0BCD', 5],
  ['\u0BB5\u0BB0\u0BCD', 1],
  ['\u0BBE\u0BB0\u0BCD', 5],
  ['\u0BA9\u0BBE\u0BB0\u0BCD', 1, 1],
  ['\u0BAE\u0BBE\u0BB0\u0BCD', 1, 2],
  ['\u0B95\u0BCA\u0BA3\u0BCD\u0B9F\u0BBF\u0BB0\u0BCD', 1],
  ['\u0BA9\u0BBF\u0BB0\u0BCD', 5],
  ['\u0BC0\u0BB0\u0BCD', 5],
  ['\u0BA9\u0BB3\u0BCD', 1],
  ['\u0BAA\u0BB3\u0BCD', 1],
  ['\u0BB5\u0BB3\u0BCD', 1],
  ['\u0BBE\u0BB3\u0BCD', 5],
  ['\u0BA9\u0BBE\u0BB3\u0BCD', 1, 1],
]

const a_26: Among[] = [
  ['\u0B95\u0BBF\u0BB1', -1],
  ['\u0B95\u0BBF\u0BA9\u0BCD\u0BB1', -1],
  ['\u0BBE\u0BA8\u0BBF\u0BA9\u0BCD\u0BB1', -1],
  ['\u0B95\u0BBF\u0BB1\u0BCD', -1],
  ['\u0B95\u0BBF\u0BA9\u0BCD\u0BB1\u0BCD', -1],
  ['\u0BBE\u0BA8\u0BBF\u0BA9\u0BCD\u0BB1\u0BCD', -1],
]

export class TamilStemmer extends BaseStemmer {
  #B_found_vetrumai_urupu /**@type {boolean}*/ = false

  #r_fix_va_start(): boolean {
    let a: number
    this.bra = this.c
    a = this.find_among(a_0)
    if (a === 0) return false
    this.ket = this.c
    this.slice_from(as_0[a - 1])
    return true
  }

  #r_fix_endings(): boolean {
    const v_1: number = this.c
    while (true) {
      const v_2: number = this.c
      lab1: {
        if (!this.#r_fix_ending()) break lab1
        continue
      }
      this.c = v_2
      break
    }
    this.c = v_1
    return true
  }

  #r_fix_ending(): boolean {
    let a: number
    if (/**@type {boolean}*/ (this.current.length < 4)) return false
    this.limit_backward = this.c
    this.c = this.limit
    lab0: {
      const v_1: number = this.limit - this.c
      lab1: {
        this.ket = this.c
        a = this.find_among_b(a_5)
        if (a === 0) break lab1
        this.bra = this.c
        switch (a) {
          case 1: {
            this.slice_del()
            break
          }
          case 2: {
            const v_2: number = this.limit - this.c
            if (this.find_among_b(a_2) === 0) break lab1
            this.c = this.limit - v_2
            this.slice_del()
            break
          }
          case 3: {
            this.slice_from('\u0BB3\u0BCD')
            break
          }
          case 4: {
            this.slice_from('\u0BB2\u0BCD')
            break
          }
          case 5: {
            this.slice_from('\u0B9F\u0BC1')
            break
          }
          case 6: {
            if (!this.#B_found_vetrumai_urupu) break lab1
            lab2: {
              if (!this.eq_s_b('\u0BC8')) break lab2
              break lab1
            }
            this.slice_from('\u0BAE\u0BCD')
            break
          }
          case 7: {
            this.slice_from('\u0BCD')
            break
          }
          case 8: {
            {
              const v_3: number = this.limit - this.c
              lab3: {
                if (this.find_among_b(a_3) === 0) break lab3
                break lab1
              }
              this.c = this.limit - v_3
            }
            this.slice_del()
            break
          }
          case 9: {
            a = this.find_among_b(a_4)
            this.slice_from(as_4[a - 1])
            break
          }
        }
        break lab0
      }
      this.c = this.limit - v_1
      this.ket = this.c
      if (!this.eq_s_b('\u0BCD')) return false
      lab4: {
        const v_4: number = this.limit - this.c
        lab5: {
          if (this.find_among_b(a_6) === 0) break lab5
          const v_5: number = this.limit - this.c
          lab6: {
            if (!this.eq_s_b('\u0BCD')) {
              this.c = this.limit - v_5
              break lab6
            }
            if (this.find_among_b(a_7) === 0) {
              this.c = this.limit - v_5
              break lab6
            }
          }
          this.bra = this.c
          this.slice_del()
          break lab4
        }
        this.c = this.limit - v_4
        lab7: {
          if (this.find_among_b(a_8) === 0) break lab7
          this.bra = this.c
          if (!this.eq_s_b('\u0BCD')) break lab7
          this.slice_del()
          break lab4
        }
        this.c = this.limit - v_4
        const v_6: number = this.limit - this.c
        if (this.find_among_b(a_9) === 0) return false
        this.c = this.limit - v_6
        this.bra = this.c
        this.slice_del()
      }
    }
    this.c = this.limit_backward
    return true
  }

  #stem(): boolean {
    let a: number
    let B_found_a_match: boolean
    this.#B_found_vetrumai_urupu = false
    const v_1: number = this.c
    this.#r_fix_ending()
    this.c = v_1
    if (/**@type {boolean}*/ (this.current.length < 5)) return false
    const v_2: number = this.c
    lab0: {
      this.bra = this.c
      if (!this.eq_s('\u0B8E')) break lab0
      if (this.find_among(a_1) === 0) break lab0
      if (!this.eq_s('\u0BCD')) break lab0
      this.ket = this.c
      this.slice_del()
      const v_3: number = this.c
      this.#r_fix_va_start()
      this.c = v_3
    }
    this.c = v_2
    const v_4: number = this.c
    lab1: {
      this.bra = this.c
      if (this.find_among(a_10) === 0) break lab1
      if (this.find_among(a_11) === 0) break lab1
      if (!this.eq_s('\u0BCD')) break lab1
      this.ket = this.c
      this.slice_del()
      const v_5: number = this.c
      this.#r_fix_va_start()
      this.c = v_5
    }
    this.c = v_4
    lab2: {
      if (/**@type {boolean}*/ (this.current.length < 5)) break lab2
      this.limit_backward = this.c
      this.c = this.limit
      const v_6: number = this.limit - this.c
      lab3: {
        this.ket = this.c
        if (this.find_among_b(a_14) === 0) break lab3
        this.bra = this.c
        this.slice_from('\u0BCD')
      }
      this.c = this.limit - v_6
      this.c = this.limit_backward
      this.#r_fix_endings()
    }
    const v_7: number = this.c
    lab4: {
      if (/**@type {boolean}*/ (this.current.length < 5)) break lab4
      this.limit_backward = this.c
      this.c = this.limit
      this.ket = this.c
      if (!this.eq_s_b('\u0BC1\u0BAE\u0BCD')) break lab4
      this.bra = this.c
      this.slice_from('\u0BCD')
      this.c = this.limit_backward
      const v_8: number = this.c
      this.#r_fix_ending()
      this.c = v_8
    }
    this.c = v_7
    const v_9: number = this.c
    lab5: {
      if (/**@type {boolean}*/ (this.current.length < 5)) break lab5
      this.limit_backward = this.c
      this.c = this.limit
      this.ket = this.c
      a = this.find_among_b(a_17)
      if (a === 0) break lab5
      this.bra = this.c
      switch (a) {
        case 1: {
          this.slice_from('\u0BCD')
          break
        }
        case 2: {
          {
            const v_10: number = this.limit - this.c
            lab6: {
              if (this.find_among_b(a_16) === 0) break lab6
              break lab5
            }
            this.c = this.limit - v_10
          }
          this.slice_from('\u0BCD')
          break
        }
        case 3: {
          this.slice_del()
          break
        }
      }
      this.c = this.limit_backward
      this.#r_fix_endings()
    }
    this.c = v_9
    const v_11: number = this.c
    lab7: {
      this.#B_found_vetrumai_urupu = false
      if (/**@type {boolean}*/ (this.current.length < 5)) break lab7
      this.limit_backward = this.c
      this.c = this.limit
      lab8: {
        const v_12: number = this.limit - this.c
        lab9: {
          const v_13: number = this.limit - this.c
          this.ket = this.c
          a = this.find_among_b(a_20)
          if (a === 0) break lab9
          this.bra = this.c
          switch (a) {
            case 1: {
              this.slice_del()
              break
            }
            case 2: {
              this.slice_from('\u0BCD')
              break
            }
            case 3: {
              lab10: {
                if (!this.eq_s_b('\u0BAE')) break lab10
                break lab9
              }
              this.slice_from('\u0BCD')
              break
            }
            case 4: {
              if (/**@type {boolean}*/ (this.current.length < 7)) break lab9
              this.slice_from('\u0BCD')
              break
            }
            case 5: {
              {
                const v_14: number = this.limit - this.c
                lab11: {
                  if (this.find_among_b(a_18) === 0) break lab11
                  break lab9
                }
                this.c = this.limit - v_14
              }
              this.slice_from('\u0BCD')
              break
            }
            case 6: {
              {
                const v_15: number = this.limit - this.c
                lab12: {
                  if (this.find_among_b(a_19) === 0) break lab12
                  break lab9
                }
                this.c = this.limit - v_15
              }
              this.slice_del()
              break
            }
            case 7: {
              this.slice_from('\u0BBF')
              break
            }
          }
          this.c = this.limit - v_13
          break lab8
        }
        this.c = this.limit - v_12
        const v_16: number = this.limit - this.c
        this.ket = this.c
        if (!this.eq_s_b('\u0BC8')) break lab7
        lab13: {
          const v_17: number = this.limit - this.c
          lab14: {
            {
              const v_18: number = this.limit - this.c
              lab15: {
                if (this.find_among_b(a_21) === 0) break lab15
                break lab14
              }
              this.c = this.limit - v_18
            }
            break lab13
          }
          this.c = this.limit - v_17
          const v_19: number = this.limit - this.c
          if (this.find_among_b(a_22) === 0) break lab7
          if (!this.eq_s_b('\u0BCD')) break lab7
          this.c = this.limit - v_19
        }
        this.bra = this.c
        this.slice_from('\u0BCD')
        this.c = this.limit - v_16
      }
      this.#B_found_vetrumai_urupu = true
      const v_20: number = this.limit - this.c
      lab16: {
        this.ket = this.c
        if (!this.eq_s_b('\u0BBF\u0BA9\u0BCD')) break lab16
        this.bra = this.c
        this.slice_from('\u0BCD')
      }
      this.c = this.limit - v_20
      this.c = this.limit_backward
      this.#r_fix_endings()
    }
    this.c = v_11
    const v_21: number = this.c
    lab17: {
      this.limit_backward = this.c
      this.c = this.limit
      this.ket = this.c
      a = this.find_among_b(a_13)
      if (a === 0) break lab17
      this.bra = this.c
      switch (a) {
        case 1: {
          lab18: {
            const v_22: number = this.limit - this.c
            lab19: {
              if (this.find_among_b(a_12) === 0) break lab19
              this.slice_from('\u0BC1\u0B99\u0BCD')
              break lab18
            }
            this.c = this.limit - v_22
            this.slice_from('\u0BCD')
          }
          break
        }
        case 2: {
          this.slice_from('\u0BB2\u0BCD')
          break
        }
        case 3: {
          this.slice_from('\u0BB3\u0BCD')
          break
        }
        case 4: {
          this.slice_del()
          break
        }
      }
      this.c = this.limit_backward
    }
    this.c = v_21
    const v_23: number = this.c
    lab20: {
      if (/**@type {boolean}*/ (this.current.length < 5)) break lab20
      this.limit_backward = this.c
      this.c = this.limit
      this.ket = this.c
      if (this.find_among_b(a_15) === 0) break lab20
      this.bra = this.c
      this.slice_del()
      this.c = this.limit_backward
    }
    this.c = v_23
    const v_24: number = this.c
    while (true) {
      const v_25: number = this.c
      lab22: {
        B_found_a_match = false
        if (/**@type {boolean}*/ (this.current.length < 5)) break lab22
        this.limit_backward = this.c
        this.c = this.limit
        const v_26: number = this.limit - this.c
        lab23: {
          const v_27: number = this.limit - this.c
          this.ket = this.c
          a = this.find_among_b(a_25)
          if (a === 0) break lab23
          this.bra = this.c
          switch (a) {
            case 1: {
              this.slice_del()
              break
            }
            case 2: {
              {
                const v_28: number = this.limit - this.c
                lab24: {
                  if (this.find_among_b(a_23) === 0) break lab24
                  break lab23
                }
                this.c = this.limit - v_28
              }
              this.slice_del()
              break
            }
            case 3: {
              {
                const v_29: number = this.limit - this.c
                lab25: {
                  if (this.find_among_b(a_24) === 0) break lab25
                  break lab23
                }
                this.c = this.limit - v_29
              }
              this.slice_del()
              break
            }
            case 4: {
              lab26: {
                if (!this.eq_s_b('\u0B9A')) break lab26
                break lab23
              }
              this.slice_from('\u0BCD')
              break
            }
            case 5: {
              this.slice_from('\u0BCD')
              break
            }
            case 6: {
              const v_30: number = this.limit - this.c
              if (!this.eq_s_b('\u0BCD')) break lab23
              this.c = this.limit - v_30
              this.slice_del()
              break
            }
          }
          B_found_a_match = true
          this.c = this.limit - v_27
        }
        this.c = this.limit - v_26
        const v_31: number = this.limit - this.c
        lab27: {
          this.ket = this.c
          if (this.find_among_b(a_26) === 0) break lab27
          this.bra = this.c
          this.slice_del()
          B_found_a_match = true
        }
        this.c = this.limit - v_31
        this.c = this.limit_backward
        this.#r_fix_endings()
        if (!B_found_a_match) break lab22
        continue
      }
      this.c = v_25
      break
    }
    this.c = v_24
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new TamilStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'f859bf3d19447fbc'
