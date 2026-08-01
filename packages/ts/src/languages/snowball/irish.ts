/*
 * Generated from algorithms/irish.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision c79c8adddaf02ae4
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ["b'", 1],
  ['bh', 4],
  ['bhf', 2, 1],
  ['bp', 8],
  ['ch', 5],
  ["d'", 1],
  ["d'fh", 2, 1],
  ['dh', 6],
  ['dt', 9],
  ['fh', 2],
  ['gc', 5],
  ['gh', 7],
  ['h-', 1],
  ["m'", 1],
  ['mb', 4],
  ['mh', 10],
  ['n-', 1],
  ['nd', 6],
  ['ng', 7],
  ['ph', 8],
  ['sh', 3],
  ['t-', 1],
  ['th', 9],
  ['ts', 3],
]

const as_0: string[] = ['', 'f', 's', 'b', 'c', 'd', 'g', 'p', 't', 'm']

const a_1: Among[] = [
  ['\u00EDochta', 1],
  ['a\u00EDochta', 1, 1],
  ['ire', 2],
  ['aire', 2, 1],
  ['abh', 1],
  ['eabh', 1, 1],
  ['ibh', 1],
  ['aibh', 1, 1],
  ['amh', 1],
  ['eamh', 1, 1],
  ['imh', 1],
  ['aimh', 1, 1],
  ['\u00EDocht', 1],
  ['a\u00EDocht', 1, 1],
  ['ir\u00ED', 2],
  ['air\u00ED', 2, 1],
]

const a_2: Among[] = [
  ['\u00F3ideacha', 6],
  ['patacha', 5],
  ['achta', 1],
  ['arcachta', 2, 1],
  ['eachta', 1, 2],
  ['grafa\u00EDochta', 4],
  ['paite', 5],
  ['ach', 1],
  ['each', 1, 1],
  ['\u00F3ideach', 6, 1],
  ['gineach', 3, 2],
  ['patach', 5, 4],
  ['grafa\u00EDoch', 4],
  ['pataigh', 5],
  ['\u00F3idigh', 6],
  ['acht\u00FAil', 1],
  ['eacht\u00FAil', 1, 1],
  ['gineas', 3],
  ['ginis', 3],
  ['acht', 1],
  ['arcacht', 2, 1],
  ['eacht', 1, 2],
  ['grafa\u00EDocht', 4],
  ['arcachta\u00ED', 2],
  ['grafa\u00EDochta\u00ED', 4],
]

const a_3: Among[] = [
  ['imid', 1],
  ['aimid', 1, 1],
  ['\u00EDmid', 1],
  ['a\u00EDmid', 1, 1],
  ['adh', 2],
  ['eadh', 2, 1],
  ['faidh', 1],
  ['fidh', 1],
  ['\u00E1il', 2],
  ['ain', 2],
  ['tear', 2],
  ['tar', 2],
]

const g_v: number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 2]

export class IrishStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let I_p2: number
    let I_p1: number
    let I_pV: number
    const v_1: number = this.c
    lab0: {
      this.bra = this.c
      a = this.find_among(a_0)
      if (a === 0) break lab0
      this.ket = this.c
      this.slice_from(as_0[a - 1])
    }
    this.c = v_1
    {
      I_pV = this.limit
      I_p1 = this.limit
      I_p2 = this.limit
      const v_2: number = this.c
      lab2: {
        if (!this.go_out_grouping(g_v, 97, 250)) break lab2
        this.c++
        I_pV = this.c
        if (!this.go_in_grouping(g_v, 97, 250)) break lab2
        this.c++
        I_p1 = this.c
        if (!this.go_out_grouping(g_v, 97, 250)) break lab2
        this.c++
        if (!this.go_in_grouping(g_v, 97, 250)) break lab2
        this.c++
        I_p2 = this.c
      }
      this.c = v_2
    }
    this.limit_backward = this.c
    this.c = this.limit
    const v_3: number = this.limit - this.c
    lab3: {
      this.ket = this.c
      a = this.find_among_b(a_1)
      if (a === 0) break lab3
      this.bra = this.c
      switch (a) {
        case 1: {
          if (/**@type {boolean}*/ (I_p1 > this.c)) break lab3
          this.slice_del()
          break
        }
        case 2: {
          if (/**@type {boolean}*/ (I_p2 > this.c)) break lab3
          this.slice_del()
          break
        }
      }
    }
    this.c = this.limit - v_3
    const v_4: number = this.limit - this.c
    lab4: {
      this.ket = this.c
      a = this.find_among_b(a_2)
      if (a === 0) break lab4
      this.bra = this.c
      switch (a) {
        case 1: {
          if (/**@type {boolean}*/ (I_p2 > this.c)) break lab4
          this.slice_del()
          break
        }
        case 2: {
          this.slice_from('arc')
          break
        }
        case 3: {
          this.slice_from('gin')
          break
        }
        case 4: {
          this.slice_from('graf')
          break
        }
        case 5: {
          this.slice_from('paite')
          break
        }
        case 6: {
          this.slice_from('\u00F3id')
          break
        }
      }
    }
    this.c = this.limit - v_4
    const v_5: number = this.limit - this.c
    lab5: {
      this.ket = this.c
      a = this.find_among_b(a_3)
      if (a === 0) break lab5
      this.bra = this.c
      switch (a) {
        case 1: {
          if (/**@type {boolean}*/ (I_pV > this.c)) break lab5
          this.slice_del()
          break
        }
        case 2: {
          if (/**@type {boolean}*/ (I_p1 > this.c)) break lab5
          this.slice_del()
          break
        }
      }
    }
    this.c = this.limit - v_5
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new IrishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'c79c8adddaf02ae4'
