/*
 * Generated from algorithms/danish.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 4337c6ed283fa798
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['hed', 1],
  ['ethed', 1, 1],
  ['ered', 1],
  ['e', 1],
  ['erede', 1, 1],
  ['ende', 1, 2],
  ['erende', 1, 1],
  ['ene', 1, 4],
  ['erne', 1, 5],
  ['ere', 1, 6],
  ['en', 1],
  ['heden', 1, 1],
  ['eren', 1, 2],
  ['er', 1],
  ['heder', 1, 1],
  ['erer', 1, 2],
  ['s', 2],
  ['heds', 1, 1],
  ['es', 1, 2],
  ['endes', 1, 1],
  ['erendes', 1, 1],
  ['enes', 1, 3],
  ['ernes', 1, 4],
  ['eres', 1, 5],
  ['ens', 1, 8],
  ['hedens', 1, 1],
  ['erens', 1, 2],
  ['ers', 1, 11],
  ['ets', 1, 12],
  ['erets', 1, 1],
  ['et', 1],
  ['eret', 1, 1],
]

const a_1: Among[] = [
  ['gd', -1],
  ['dt', -1],
  ['gt', -1],
  ['kt', -1],
]

const a_2: Among[] = [
  ['ig', 1],
  ['lig', 1, 1],
  ['elig', 1, 1],
  ['els', 1],
  ['l\u00F8st', 2],
]

const g_undouble_c: number[] = [53, 94, 7]

const g_v: number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 48, 0, 128]

const g_s_ending: number[] = [1, 0, 0, 0, 0, 0, 0, 188, 251, 171, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64]

export class DanishStemmer extends BaseStemmer {
  #I_p1 /**@type {number}*/ = 0

  #r_consonant_pair(): boolean {
    const v_1: number = this.limit - this.c
    if (this.c < this.#I_p1) return false
    const v_2: number = this.limit_backward
    this.limit_backward = this.#I_p1
    this.ket = this.c
    if (this.find_among_b(a_1) === 0) {
      this.limit_backward = v_2
      return false
    }
    this.bra = this.c
    this.limit_backward = v_2
    this.c = this.limit - v_1
    if (this.c <= this.limit_backward) return false
    this.c--
    this.bra = this.c
    this.slice_del()
    return true
  }

  #stem(): boolean {
    let a: number
    let S_ch: string
    this.#I_p1 = this.limit
    const v_1: number = this.c
    lab0: {
      lab1: {
        const v_2: number = this.c
        lab2: {
          while (true) {
            lab4: {
              if (!this.eq_s("'")) break lab4
              break
            }
            if (this.c >= this.limit) break lab2
            this.c++
          }
          break lab1
        }
        this.c = v_2
        if (!this.go_out_grouping(g_v, 97, 248)) break lab0
        this.c++
        if (!this.go_in_grouping(g_v, 97, 248)) break lab0
        this.c++
      }
      this.#I_p1 = this.c
    }
    this.c = v_1
    const v_3: number = this.c
    if (this.c + 3 > this.limit) return false
    this.c += 3
    lab5: {
      if (/**@type {boolean}*/ (this.#I_p1 >= this.c)) break lab5
      this.#I_p1 = this.c
    }
    this.c = v_3
    this.limit_backward = this.c
    this.c = this.limit
    const v_4: number = this.limit - this.c
    lab6: {
      if (this.c < this.#I_p1) break lab6
      const v_5: number = this.limit_backward
      this.limit_backward = this.#I_p1
      this.ket = this.c
      a = this.find_among_b(a_0)
      if (a === 0) {
        this.limit_backward = v_5
        break lab6
      }
      this.bra = this.c
      this.limit_backward = v_5
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          if (!this.in_grouping_b(g_s_ending, 39, 229)) break lab6
          this.slice_del()
          break
        }
      }
    }
    this.c = this.limit - v_4
    const v_6: number = this.limit - this.c
    this.#r_consonant_pair()
    this.c = this.limit - v_6
    const v_7: number = this.limit - this.c
    lab7: {
      const v_8: number = this.limit - this.c
      lab8: {
        this.ket = this.c
        if (!this.eq_s_b('st')) break lab8
        this.bra = this.c
        if (!this.eq_s_b('ig')) break lab8
        this.slice_del()
      }
      this.c = this.limit - v_8
      if (this.c < this.#I_p1) break lab7
      const v_9: number = this.limit_backward
      this.limit_backward = this.#I_p1
      this.ket = this.c
      a = this.find_among_b(a_2)
      if (a === 0) {
        this.limit_backward = v_9
        break lab7
      }
      this.bra = this.c
      this.limit_backward = v_9
      switch (a) {
        case 1: {
          this.slice_del()
          const v_10: number = this.limit - this.c
          this.#r_consonant_pair()
          this.c = this.limit - v_10
          break
        }
        case 2: {
          this.slice_from('l\u00F8s')
          break
        }
      }
    }
    this.c = this.limit - v_7
    const v_11: number = this.limit - this.c
    lab9: {
      if (this.c < this.#I_p1) break lab9
      const v_12: number = this.limit_backward
      this.limit_backward = this.#I_p1
      this.ket = this.c
      if (!this.in_grouping_b(g_undouble_c, 98, 116)) {
        this.limit_backward = v_12
        break lab9
      }
      this.bra = this.c
      S_ch = this.slice_to()
      this.limit_backward = v_12
      if (!this.eq_s_b(S_ch)) break lab9
      this.slice_del()
    }
    this.c = this.limit - v_11
    this.ket = this.c
    if (!this.eq_s_b("'")) return false
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

const shared = new DanishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '4337c6ed283fa798'
