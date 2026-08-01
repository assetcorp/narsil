/*
 * Generated from algorithms/hungarian.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 7b9c2fc79181fc11
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['\u00E1', 1],
  ['\u00E9', 2],
]

const as_0: string[] = ['a', 'e']

const a_1: Among[] = [
  ['bb', -1],
  ['cc', -1],
  ['dd', -1],
  ['ff', -1],
  ['gg', -1],
  ['jj', -1],
  ['kk', -1],
  ['ll', -1],
  ['mm', -1],
  ['nn', -1],
  ['pp', -1],
  ['rr', -1],
  ['ccs', -1],
  ['ss', -1],
  ['zzs', -1],
  ['tt', -1],
  ['vv', -1],
  ['ggy', -1],
  ['lly', -1],
  ['nny', -1],
  ['tty', -1],
  ['ssz', -1],
  ['zz', -1],
]

const a_2: Among[] = [
  ['al', 1],
  ['el', 1],
]

const a_3: Among[] = [
  ['ba', -1],
  ['ra', -1],
  ['be', -1],
  ['re', -1],
  ['ig', -1],
  ['nak', -1],
  ['nek', -1],
  ['val', -1],
  ['vel', -1],
  ['ul', -1],
  ['n\u00E1l', -1],
  ['n\u00E9l', -1],
  ['b\u00F3l', -1],
  ['r\u00F3l', -1],
  ['t\u00F3l', -1],
  ['\u00FCl', -1],
  ['b\u0151l', -1],
  ['r\u0151l', -1],
  ['t\u0151l', -1],
  ['n', -1],
  ['an', -1, 1],
  ['ban', -1, 1],
  ['en', -1, 3],
  ['ben', -1, 1],
  ['k\u00E9ppen', -1, 2],
  ['on', -1, 6],
  ['\u00F6n', -1, 7],
  ['k\u00E9pp', -1],
  ['kor', -1],
  ['t', -1],
  ['at', -1, 1],
  ['et', -1, 2],
  ['k\u00E9nt', -1, 3],
  ['ank\u00E9nt', -1, 1],
  ['enk\u00E9nt', -1, 2],
  ['onk\u00E9nt', -1, 3],
  ['ot', -1, 7],
  ['\u00E9rt', -1, 8],
  ['\u00F6t', -1, 9],
  ['hez', -1],
  ['hoz', -1],
  ['h\u00F6z', -1],
  ['v\u00E1', -1],
  ['v\u00E9', -1],
]

const a_4: Among[] = [
  ['\u00E1n', 2],
  ['\u00E9n', 1],
  ['\u00E1nk\u00E9nt', 2],
]

const as_4: string[] = ['e', 'a']

const a_5: Among[] = [
  ['stul', 1],
  ['astul', 1, 1],
  ['\u00E1stul', 2, 2],
  ['st\u00FCl', 1],
  ['est\u00FCl', 1, 1],
  ['\u00E9st\u00FCl', 3, 2],
]

const as_5: string[] = ['', 'a', 'e']

const a_6: Among[] = [
  ['\u00E1', 1],
  ['\u00E9', 1],
]

const a_7: Among[] = [
  ['k', 3],
  ['ak', 3, 1],
  ['ek', 3, 2],
  ['ok', 3, 3],
  ['\u00E1k', 1, 4],
  ['\u00E9k', 2, 5],
  ['\u00F6k', 3, 6],
]

const as_7: string[] = ['a', 'e', '']

const a_8: Among[] = [
  ['\u00E9i', 1],
  ['\u00E1\u00E9i', 3, 1],
  ['\u00E9\u00E9i', 2, 2],
  ['\u00E9', 1],
  ['k\u00E9', 1, 1],
  ['ak\u00E9', 1, 1],
  ['ek\u00E9', 1, 2],
  ['ok\u00E9', 1, 3],
  ['\u00E1k\u00E9', 3, 4],
  ['\u00E9k\u00E9', 2, 5],
  ['\u00F6k\u00E9', 1, 6],
  ['\u00E9\u00E9', 2, 8],
]

const as_8: string[] = ['', 'e', 'a']

const a_9: Among[] = [
  ['a', 1],
  ['ja', 1, 1],
  ['d', 1],
  ['ad', 1, 1],
  ['ed', 1, 2],
  ['od', 1, 3],
  ['\u00E1d', 2, 4],
  ['\u00E9d', 3, 5],
  ['\u00F6d', 1, 6],
  ['e', 1],
  ['je', 1, 1],
  ['nk', 1],
  ['unk', 1, 1],
  ['\u00E1nk', 2, 2],
  ['\u00E9nk', 3, 3],
  ['\u00FCnk', 1, 4],
  ['uk', 1],
  ['juk', 1, 1],
  ['\u00E1juk', 2, 1],
  ['\u00FCk', 1],
  ['j\u00FCk', 1, 1],
  ['\u00E9j\u00FCk', 3, 1],
  ['m', 1],
  ['am', 1, 1],
  ['em', 1, 2],
  ['om', 1, 3],
  ['\u00E1m', 2, 4],
  ['\u00E9m', 3, 5],
  ['o', 1],
  ['\u00E1', 2],
  ['\u00E9', 3],
]

const as_9: string[] = ['', 'a', 'e']

const a_10: Among[] = [
  ['id', 1],
  ['aid', 1, 1],
  ['jaid', 1, 1],
  ['eid', 1, 3],
  ['jeid', 1, 1],
  ['\u00E1id', 2, 5],
  ['\u00E9id', 3, 6],
  ['i', 1],
  ['ai', 1, 1],
  ['jai', 1, 1],
  ['ei', 1, 3],
  ['jei', 1, 1],
  ['\u00E1i', 2, 5],
  ['\u00E9i', 3, 6],
  ['itek', 1],
  ['eitek', 1, 1],
  ['jeitek', 1, 1],
  ['\u00E9itek', 3, 3],
  ['ik', 1],
  ['aik', 1, 1],
  ['jaik', 1, 1],
  ['eik', 1, 3],
  ['jeik', 1, 1],
  ['\u00E1ik', 2, 5],
  ['\u00E9ik', 3, 6],
  ['ink', 1],
  ['aink', 1, 1],
  ['jaink', 1, 1],
  ['eink', 1, 3],
  ['jeink', 1, 1],
  ['\u00E1ink', 2, 5],
  ['\u00E9ink', 3, 6],
  ['aitok', 1],
  ['jaitok', 1, 1],
  ['\u00E1itok', 2],
  ['im', 1],
  ['aim', 1, 1],
  ['jaim', 1, 1],
  ['eim', 1, 3],
  ['jeim', 1, 1],
  ['\u00E1im', 2, 5],
  ['\u00E9im', 3, 6],
]

const as_10: string[] = ['', 'a', 'e']

const g_v: number[] = [
  17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 36, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1,
]

export class HungarianStemmer extends BaseStemmer {
  #r_double(): boolean {
    const v_1: number = this.limit - this.c
    if (this.find_among_b(a_1) === 0) return false
    this.c = this.limit - v_1
    return true
  }

  #r_undouble(): boolean {
    if (this.c <= this.limit_backward) return false
    this.c--
    this.ket = this.c
    if (this.c <= this.limit_backward) return false
    this.c--
    this.bra = this.c
    this.slice_del()
    return true
  }

  #stem(): boolean {
    let a: number
    let I_p1: number
    const v_1: number = this.c
    lab0: {
      I_p1 = this.limit
      lab1: {
        const v_2: number = this.c
        lab2: {
          if (!this.in_grouping(g_v, 97, 369)) break lab2
          const v_3: number = this.c
          lab3: {
            if (!this.go_in_grouping(g_v, 97, 369)) break lab3
            this.c++
            I_p1 = this.c
          }
          this.c = v_3
          break lab1
        }
        this.c = v_2
        if (!this.go_out_grouping(g_v, 97, 369)) break lab0
        this.c++
        I_p1 = this.c
      }
    }
    this.c = v_1
    this.limit_backward = this.c
    this.c = this.limit
    const v_4: number = this.limit - this.c
    lab4: {
      this.ket = this.c
      if (this.find_among_b(a_2) === 0) break lab4
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab4
      if (!this.#r_double()) break lab4
      this.slice_del()
      if (!this.#r_undouble()) break lab4
    }
    this.c = this.limit - v_4
    const v_5: number = this.limit - this.c
    lab5: {
      this.ket = this.c
      if (this.find_among_b(a_3) === 0) break lab5
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab5
      this.slice_del()
      this.ket = this.c
      a = this.find_among_b(a_0)
      if (a === 0) break lab5
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab5
      this.slice_from(as_0[a - 1])
    }
    this.c = this.limit - v_5
    const v_6: number = this.limit - this.c
    lab6: {
      this.ket = this.c
      a = this.find_among_b(a_4)
      if (a === 0) break lab6
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab6
      this.slice_from(as_4[a - 1])
    }
    this.c = this.limit - v_6
    const v_7: number = this.limit - this.c
    lab7: {
      this.ket = this.c
      a = this.find_among_b(a_5)
      if (a === 0) break lab7
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab7
      this.slice_from(as_5[a - 1])
    }
    this.c = this.limit - v_7
    const v_8: number = this.limit - this.c
    lab8: {
      this.ket = this.c
      if (this.find_among_b(a_6) === 0) break lab8
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab8
      if (!this.#r_double()) break lab8
      this.slice_del()
      if (!this.#r_undouble()) break lab8
    }
    this.c = this.limit - v_8
    const v_9: number = this.limit - this.c
    lab9: {
      this.ket = this.c
      a = this.find_among_b(a_8)
      if (a === 0) break lab9
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab9
      this.slice_from(as_8[a - 1])
    }
    this.c = this.limit - v_9
    const v_10: number = this.limit - this.c
    lab10: {
      this.ket = this.c
      a = this.find_among_b(a_9)
      if (a === 0) break lab10
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab10
      this.slice_from(as_9[a - 1])
    }
    this.c = this.limit - v_10
    const v_11: number = this.limit - this.c
    lab11: {
      this.ket = this.c
      a = this.find_among_b(a_10)
      if (a === 0) break lab11
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab11
      this.slice_from(as_10[a - 1])
    }
    this.c = this.limit - v_11
    const v_12: number = this.limit - this.c
    lab12: {
      this.ket = this.c
      a = this.find_among_b(a_7)
      if (a === 0) break lab12
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab12
      this.slice_from(as_7[a - 1])
    }
    this.c = this.limit - v_12
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new HungarianStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '7b9c2fc79181fc11'
