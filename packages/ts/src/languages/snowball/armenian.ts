/*
 * Generated from algorithms/armenian.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 6d99ac3501d5d369
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['\u0580\u0578\u0580\u0564', 1],
  ['\u0565\u0580\u0578\u0580\u0564', 1, 1],
  ['\u0561\u056C\u056B', 1],
  ['\u0561\u056F\u056B', 1],
  ['\u0578\u0580\u0561\u056F', 1],
  ['\u0565\u0572', 1],
  ['\u0561\u056F\u0561\u0576', 1],
  ['\u0561\u0580\u0561\u0576', 1],
  ['\u0565\u0576', 1],
  ['\u0565\u056F\u0565\u0576', 1, 1],
  ['\u0565\u0580\u0565\u0576', 1, 2],
  ['\u0578\u0580\u0567\u0576', 1],
  ['\u056B\u0576', 1],
  ['\u0563\u056B\u0576', 1, 1],
  ['\u0578\u057E\u056B\u0576', 1, 2],
  ['\u056C\u0561\u0575\u0576', 1],
  ['\u057E\u0578\u0582\u0576', 1],
  ['\u057A\u0565\u057D', 1],
  ['\u056B\u057E', 1],
  ['\u0561\u057F', 1],
  ['\u0561\u057E\u0565\u057F', 1],
  ['\u056F\u0578\u057F', 1],
  ['\u0562\u0561\u0580', 1],
]

const a_1: Among[] = [
  ['\u0561', 1],
  ['\u0561\u0581\u0561', 1, 1],
  ['\u0565\u0581\u0561', 1, 2],
  ['\u057E\u0565', 1],
  ['\u0561\u0581\u0580\u056B', 1],
  ['\u0561\u0581\u056B', 1],
  ['\u0565\u0581\u056B', 1],
  ['\u057E\u0565\u0581\u056B', 1, 1],
  ['\u0561\u056C', 1],
  ['\u0568\u0561\u056C', 1, 1],
  ['\u0561\u0576\u0561\u056C', 1, 2],
  ['\u0565\u0576\u0561\u056C', 1, 3],
  ['\u0561\u0581\u0576\u0561\u056C', 1, 4],
  ['\u0565\u056C', 1],
  ['\u0568\u0565\u056C', 1, 1],
  ['\u0576\u0565\u056C', 1, 2],
  ['\u0581\u0576\u0565\u056C', 1, 1],
  ['\u0565\u0581\u0576\u0565\u056C', 1, 1],
  ['\u0579\u0565\u056C', 1, 5],
  ['\u057E\u0565\u056C', 1, 6],
  ['\u0561\u0581\u057E\u0565\u056C', 1, 1],
  ['\u0565\u0581\u057E\u0565\u056C', 1, 2],
  ['\u057F\u0565\u056C', 1, 9],
  ['\u0561\u057F\u0565\u056C', 1, 1],
  ['\u0578\u057F\u0565\u056C', 1, 2],
  ['\u056F\u0578\u057F\u0565\u056C', 1, 1],
  ['\u057E\u0561\u056E', 1],
  ['\u0578\u0582\u0574', 1],
  ['\u057E\u0578\u0582\u0574', 1, 1],
  ['\u0561\u0576', 1],
  ['\u0581\u0561\u0576', 1, 1],
  ['\u0561\u0581\u0561\u0576', 1, 1],
  ['\u0561\u0581\u0580\u056B\u0576', 1],
  ['\u0561\u0581\u056B\u0576', 1],
  ['\u0565\u0581\u056B\u0576', 1],
  ['\u057E\u0565\u0581\u056B\u0576', 1, 1],
  ['\u0561\u056C\u056B\u057D', 1],
  ['\u0565\u056C\u056B\u057D', 1],
  ['\u0561\u057E', 1],
  ['\u0561\u0581\u0561\u057E', 1, 1],
  ['\u0565\u0581\u0561\u057E', 1, 2],
  ['\u0561\u056C\u0578\u057E', 1],
  ['\u0565\u056C\u0578\u057E', 1],
  ['\u0561\u0580', 1],
  ['\u0561\u0581\u0561\u0580', 1, 1],
  ['\u0565\u0581\u0561\u0580', 1, 2],
  ['\u0561\u0581\u0580\u056B\u0580', 1],
  ['\u0561\u0581\u056B\u0580', 1],
  ['\u0565\u0581\u056B\u0580', 1],
  ['\u057E\u0565\u0581\u056B\u0580', 1, 1],
  ['\u0561\u0581', 1],
  ['\u0565\u0581', 1],
  ['\u0561\u0581\u0580\u0565\u0581', 1, 1],
  ['\u0561\u056C\u0578\u0582\u0581', 1],
  ['\u0565\u056C\u0578\u0582\u0581', 1],
  ['\u0561\u056C\u0578\u0582', 1],
  ['\u0565\u056C\u0578\u0582', 1],
  ['\u0561\u0584', 1],
  ['\u0581\u0561\u0584', 1, 1],
  ['\u0561\u0581\u0561\u0584', 1, 1],
  ['\u0561\u0581\u0580\u056B\u0584', 1],
  ['\u0561\u0581\u056B\u0584', 1],
  ['\u0565\u0581\u056B\u0584', 1],
  ['\u057E\u0565\u0581\u056B\u0584', 1, 1],
  ['\u0561\u0576\u0584', 1],
  ['\u0581\u0561\u0576\u0584', 1, 1],
  ['\u0561\u0581\u0561\u0576\u0584', 1, 1],
  ['\u0561\u0581\u0580\u056B\u0576\u0584', 1],
  ['\u0561\u0581\u056B\u0576\u0584', 1],
  ['\u0565\u0581\u056B\u0576\u0584', 1],
  ['\u057E\u0565\u0581\u056B\u0576\u0584', 1, 1],
]

const a_2: Among[] = [
  ['\u0578\u0580\u0564', 1],
  ['\u0578\u0582\u0575\u0569', 1],
  ['\u0578\u0582\u0570\u056B', 1],
  ['\u0581\u056B', 1],
  ['\u056B\u056C', 1],
  ['\u0561\u056F', 1],
  ['\u0575\u0561\u056F', 1, 1],
  ['\u0561\u0576\u0561\u056F', 1, 2],
  ['\u056B\u056F', 1],
  ['\u0578\u0582\u056F', 1],
  ['\u0561\u0576', 1],
  ['\u057A\u0561\u0576', 1, 1],
  ['\u057D\u057F\u0561\u0576', 1, 2],
  ['\u0561\u0580\u0561\u0576', 1, 3],
  ['\u0565\u0572\u0567\u0576', 1],
  ['\u0575\u0578\u0582\u0576', 1],
  ['\u0578\u0582\u0569\u0575\u0578\u0582\u0576', 1, 1],
  ['\u0561\u056E\u0578', 1],
  ['\u056B\u0579', 1],
  ['\u0578\u0582\u057D', 1],
  ['\u0578\u0582\u057D\u057F', 1],
  ['\u0563\u0561\u0580', 1],
  ['\u057E\u0578\u0580', 1],
  ['\u0561\u057E\u0578\u0580', 1, 1],
  ['\u0578\u0581', 1],
  ['\u0561\u0576\u0585\u0581', 1],
  ['\u0578\u0582', 1],
  ['\u0584', 1],
  ['\u0579\u0565\u0584', 1, 1],
  ['\u056B\u0584', 1, 2],
  ['\u0561\u056C\u056B\u0584', 1, 1],
  ['\u0561\u0576\u056B\u0584', 1, 2],
  ['\u057E\u0561\u056E\u0584', 1, 5],
  ['\u0578\u0582\u0575\u0584', 1, 6],
  ['\u0565\u0576\u0584', 1, 7],
  ['\u0578\u0576\u0584', 1, 8],
  ['\u0578\u0582\u0576\u0584', 1, 9],
  ['\u0574\u0578\u0582\u0576\u0584', 1, 1],
  ['\u056B\u0579\u0584', 1, 11],
  ['\u0561\u0580\u0584', 1, 12],
]

const a_3: Among[] = [
  ['\u057D\u0561', 1],
  ['\u057E\u0561', 1],
  ['\u0561\u0574\u0562', 1],
  ['\u0564', 1],
  ['\u0561\u0576\u0564', 1, 1],
  ['\u0578\u0582\u0569\u0575\u0561\u0576\u0564', 1, 1],
  ['\u057E\u0561\u0576\u0564', 1, 2],
  ['\u0578\u057B\u0564', 1, 4],
  ['\u0565\u0580\u0564', 1, 5],
  ['\u0576\u0565\u0580\u0564', 1, 1],
  ['\u0578\u0582\u0564', 1, 7],
  ['\u0568', 1],
  ['\u0561\u0576\u0568', 1, 1],
  ['\u0578\u0582\u0569\u0575\u0561\u0576\u0568', 1, 1],
  ['\u057E\u0561\u0576\u0568', 1, 2],
  ['\u0578\u057B\u0568', 1, 4],
  ['\u0565\u0580\u0568', 1, 5],
  ['\u0576\u0565\u0580\u0568', 1, 1],
  ['\u056B', 1],
  ['\u057E\u056B', 1, 1],
  ['\u0565\u0580\u056B', 1, 2],
  ['\u0576\u0565\u0580\u056B', 1, 1],
  ['\u0561\u0576\u0578\u0582\u0574', 1],
  ['\u0565\u0580\u0578\u0582\u0574', 1],
  ['\u0576\u0565\u0580\u0578\u0582\u0574', 1, 1],
  ['\u0576', 1],
  ['\u0561\u0576', 1, 1],
  ['\u0578\u0582\u0569\u0575\u0561\u0576', 1, 1],
  ['\u057E\u0561\u0576', 1, 2],
  ['\u056B\u0576', 1, 4],
  ['\u0565\u0580\u056B\u0576', 1, 1],
  ['\u0576\u0565\u0580\u056B\u0576', 1, 1],
  ['\u0578\u0582\u0569\u0575\u0561\u0576\u0576', 1, 7],
  ['\u0565\u0580\u0576', 1, 8],
  ['\u0576\u0565\u0580\u0576', 1, 1],
  ['\u0578\u0582\u0576', 1, 10],
  ['\u0578\u057B', 1],
  ['\u0578\u0582\u0569\u0575\u0561\u0576\u057D', 1],
  ['\u057E\u0561\u0576\u057D', 1],
  ['\u0578\u057B\u057D', 1],
  ['\u0578\u057E', 1],
  ['\u0561\u0576\u0578\u057E', 1, 1],
  ['\u057E\u0578\u057E', 1, 2],
  ['\u0565\u0580\u0578\u057E', 1, 3],
  ['\u0576\u0565\u0580\u0578\u057E', 1, 1],
  ['\u0565\u0580', 1],
  ['\u0576\u0565\u0580', 1, 1],
  ['\u0581', 1],
  ['\u056B\u0581', 1, 1],
  ['\u057E\u0561\u0576\u056B\u0581', 1, 1],
  ['\u0578\u057B\u056B\u0581', 1, 2],
  ['\u057E\u056B\u0581', 1, 3],
  ['\u0565\u0580\u056B\u0581', 1, 4],
  ['\u0576\u0565\u0580\u056B\u0581', 1, 1],
  ['\u0581\u056B\u0581', 1, 6],
  ['\u0578\u0581', 1, 8],
  ['\u0578\u0582\u0581', 1, 9],
]

const g_v: number[] = [209, 4, 128, 0, 18]

export class ArmenianStemmer extends BaseStemmer {
  #stem(): boolean {
    let I_p2: number
    let I_pV: number
    {
      I_pV = this.limit
      I_p2 = this.limit
      const v_1: number = this.c
      lab1: {
        if (!this.go_out_grouping(g_v, 1377, 1413)) break lab1
        this.c++
        I_pV = this.c
        if (!this.go_in_grouping(g_v, 1377, 1413)) break lab1
        this.c++
        if (!this.go_out_grouping(g_v, 1377, 1413)) break lab1
        this.c++
        if (!this.go_in_grouping(g_v, 1377, 1413)) break lab1
        this.c++
        I_p2 = this.c
      }
      this.c = v_1
    }
    this.limit_backward = this.c
    this.c = this.limit
    if (this.c < I_pV) return false
    const v_2: number = this.limit_backward
    this.limit_backward = I_pV
    const v_3: number = this.limit - this.c
    lab2: {
      this.ket = this.c
      if (this.find_among_b(a_3) === 0) break lab2
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p2 > this.c)) break lab2
      this.slice_del()
    }
    this.c = this.limit - v_3
    const v_4: number = this.limit - this.c
    lab3: {
      this.ket = this.c
      if (this.find_among_b(a_1) === 0) break lab3
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_4
    const v_5: number = this.limit - this.c
    lab4: {
      this.ket = this.c
      if (this.find_among_b(a_0) === 0) break lab4
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_5
    const v_6: number = this.limit - this.c
    lab5: {
      this.ket = this.c
      if (this.find_among_b(a_2) === 0) break lab5
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_6
    this.limit_backward = v_2
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new ArmenianStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '6d99ac3501d5d369'
