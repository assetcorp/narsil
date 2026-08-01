/*
 * Generated from algorithms/romanian.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision daf797aac5310bd4
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['\u015F', 1],
  ['\u0163', 2],
]

const as_0: string[] = ['\u0219', '\u021B']

const a_1: Among[] = [
  ['', 3],
  ['I', 1, 1],
  ['U', 2, 2],
]

const a_2: Among[] = [
  ['ea', 3],
  ['a\u021Bia', 7],
  ['aua', 2],
  ['iua', 4],
  ['a\u021Bie', 7],
  ['ele', 3],
  ['ile', 5],
  ['iile', 4, 1],
  ['iei', 4],
  ['atei', 6],
  ['ii', 4],
  ['ului', 1],
  ['ul', 1],
  ['elor', 3],
  ['ilor', 4],
  ['iilor', 4, 1],
]

const a_3: Among[] = [
  ['icala', 4],
  ['iciva', 4],
  ['ativa', 5],
  ['itiva', 6],
  ['icale', 4],
  ['a\u021Biune', 5],
  ['i\u021Biune', 6],
  ['atoare', 5],
  ['itoare', 6],
  ['\u0103toare', 5],
  ['icitate', 4],
  ['abilitate', 1],
  ['ibilitate', 2],
  ['ivitate', 3],
  ['icive', 4],
  ['ative', 5],
  ['itive', 6],
  ['icali', 4],
  ['atori', 5],
  ['icatori', 4, 1],
  ['itori', 6],
  ['\u0103tori', 5],
  ['icitati', 4],
  ['abilitati', 1],
  ['ivitati', 3],
  ['icivi', 4],
  ['ativi', 5],
  ['itivi', 6],
  ['icit\u0103i', 4],
  ['abilit\u0103i', 1],
  ['ivit\u0103i', 3],
  ['icit\u0103\u021Bi', 4],
  ['abilit\u0103\u021Bi', 1],
  ['ivit\u0103\u021Bi', 3],
  ['ical', 4],
  ['ator', 5],
  ['icator', 4, 1],
  ['itor', 6],
  ['\u0103tor', 5],
  ['iciv', 4],
  ['ativ', 5],
  ['itiv', 6],
  ['ical\u0103', 4],
  ['iciv\u0103', 4],
  ['ativ\u0103', 5],
  ['itiv\u0103', 6],
]

const as_3: string[] = ['abil', 'ibil', 'iv', 'ic', 'at', 'it']

const a_4: Among[] = [
  ['ica', 1],
  ['abila', 1],
  ['ibila', 1],
  ['oasa', 1],
  ['ata', 1],
  ['ita', 1],
  ['anta', 1],
  ['ista', 3],
  ['uta', 1],
  ['iva', 1],
  ['ic', 1],
  ['ice', 1],
  ['abile', 1],
  ['ibile', 1],
  ['isme', 3],
  ['iune', 2],
  ['oase', 1],
  ['ate', 1],
  ['itate', 1, 1],
  ['ite', 1],
  ['ante', 1],
  ['iste', 3],
  ['ute', 1],
  ['ive', 1],
  ['ici', 1],
  ['abili', 1],
  ['ibili', 1],
  ['iuni', 2],
  ['atori', 1],
  ['osi', 1],
  ['ati', 1],
  ['itati', 1, 1],
  ['iti', 1],
  ['anti', 1],
  ['isti', 3],
  ['uti', 1],
  ['i\u0219ti', 3],
  ['ivi', 1],
  ['it\u0103i', 1],
  ['o\u0219i', 1],
  ['it\u0103\u021Bi', 1],
  ['abil', 1],
  ['ibil', 1],
  ['ism', 3],
  ['ator', 1],
  ['os', 1],
  ['at', 1],
  ['it', 1],
  ['ant', 1],
  ['ist', 3],
  ['ut', 1],
  ['iv', 1],
  ['ic\u0103', 1],
  ['abil\u0103', 1],
  ['ibil\u0103', 1],
  ['oas\u0103', 1],
  ['at\u0103', 1],
  ['it\u0103', 1],
  ['ant\u0103', 1],
  ['ist\u0103', 3],
  ['ut\u0103', 1],
  ['iv\u0103', 1],
]

const a_5: Among[] = [
  ['ea', 1],
  ['ia', 1],
  ['esc', 1],
  ['\u0103sc', 1],
  ['ind', 1],
  ['\u00E2nd', 1],
  ['are', 1],
  ['ere', 1],
  ['ire', 1],
  ['\u00E2re', 1],
  ['se', 2],
  ['ase', 1, 1],
  ['sese', 2, 2],
  ['ise', 1, 3],
  ['use', 1, 4],
  ['\u00E2se', 1, 5],
  ['e\u0219te', 1],
  ['\u0103\u0219te', 1],
  ['eze', 1],
  ['ai', 1],
  ['eai', 1, 1],
  ['iai', 1, 2],
  ['sei', 2],
  ['e\u0219ti', 1],
  ['\u0103\u0219ti', 1],
  ['ui', 1],
  ['ezi', 1],
  ['\u00E2i', 1],
  ['a\u0219i', 1],
  ['se\u0219i', 2],
  ['ase\u0219i', 1, 1],
  ['sese\u0219i', 2, 2],
  ['ise\u0219i', 1, 3],
  ['use\u0219i', 1, 4],
  ['\u00E2se\u0219i', 1, 5],
  ['i\u0219i', 1],
  ['u\u0219i', 1],
  ['\u00E2\u0219i', 1],
  ['a\u021Bi', 2],
  ['ea\u021Bi', 1, 1],
  ['ia\u021Bi', 1, 2],
  ['e\u021Bi', 2],
  ['i\u021Bi', 2],
  ['\u00E2\u021Bi', 2],
  ['ar\u0103\u021Bi', 1],
  ['ser\u0103\u021Bi', 2],
  ['aser\u0103\u021Bi', 1, 1],
  ['seser\u0103\u021Bi', 2, 2],
  ['iser\u0103\u021Bi', 1, 3],
  ['user\u0103\u021Bi', 1, 4],
  ['\u00E2ser\u0103\u021Bi', 1, 5],
  ['ir\u0103\u021Bi', 1],
  ['ur\u0103\u021Bi', 1],
  ['\u00E2r\u0103\u021Bi', 1],
  ['am', 1],
  ['eam', 1, 1],
  ['iam', 1, 2],
  ['em', 2],
  ['asem', 1, 1],
  ['sesem', 2, 2],
  ['isem', 1, 3],
  ['usem', 1, 4],
  ['\u00E2sem', 1, 5],
  ['im', 2],
  ['\u00E2m', 2],
  ['\u0103m', 2],
  ['ar\u0103m', 1, 1],
  ['ser\u0103m', 2, 2],
  ['aser\u0103m', 1, 1],
  ['seser\u0103m', 2, 2],
  ['iser\u0103m', 1, 3],
  ['user\u0103m', 1, 4],
  ['\u00E2ser\u0103m', 1, 5],
  ['ir\u0103m', 1, 8],
  ['ur\u0103m', 1, 9],
  ['\u00E2r\u0103m', 1, 10],
  ['au', 1],
  ['eau', 1, 1],
  ['iau', 1, 2],
  ['indu', 1],
  ['\u00E2ndu', 1],
  ['ez', 1],
  ['easc\u0103', 1],
  ['ar\u0103', 1],
  ['ser\u0103', 2],
  ['aser\u0103', 1, 1],
  ['seser\u0103', 2, 2],
  ['iser\u0103', 1, 3],
  ['user\u0103', 1, 4],
  ['\u00E2ser\u0103', 1, 5],
  ['ir\u0103', 1],
  ['ur\u0103', 1],
  ['\u00E2r\u0103', 1],
  ['eaz\u0103', 1],
]

const a_6: Among[] = [
  ['a', 1],
  ['e', 1],
  ['ie', 1, 1],
  ['i', 1],
  ['\u0103', 1],
]

const g_v: number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 32, 0, 0, 4]

export class RomanianStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let B_standard_suffix_removed: boolean
    let I_p2: number
    let I_p1: number
    let I_pV: number
    {
      const v_1: number = this.c
      while (true) {
        const v_2: number = this.c
        lab2: {
          while (true) {
            const v_3: number = this.c
            lab4: {
              this.bra = this.c
              a = this.find_among(a_0)
              if (a === 0) break lab4
              this.ket = this.c
              this.slice_from(as_0[a - 1])
              this.c = v_3
              break
            }
            this.c = v_3
            if (this.c >= this.limit) break lab2
            this.c++
          }
          continue
        }
        this.c = v_2
        break
      }
      this.c = v_1
    }
    const v_4: number = this.c
    while (true) {
      const v_5: number = this.c
      lab6: {
        while (true) {
          const v_6: number = this.c
          lab8: {
            if (!this.in_grouping(g_v, 97, 259)) break lab8
            this.bra = this.c
            lab9: {
              const v_7: number = this.c
              lab10: {
                if (!this.eq_s('u')) break lab10
                this.ket = this.c
                if (!this.in_grouping(g_v, 97, 259)) break lab10
                this.slice_from('U')
                break lab9
              }
              this.c = v_7
              if (!this.eq_s('i')) break lab8
              this.ket = this.c
              if (!this.in_grouping(g_v, 97, 259)) break lab8
              this.slice_from('I')
            }
            this.c = v_6
            break
          }
          this.c = v_6
          if (this.c >= this.limit) break lab6
          this.c++
        }
        continue
      }
      this.c = v_5
      break
    }
    this.c = v_4
    {
      I_pV = this.limit
      I_p1 = this.limit
      I_p2 = this.limit
      const v_8: number = this.c
      lab12: {
        lab13: {
          const v_9: number = this.c
          lab14: {
            if (!this.in_grouping(g_v, 97, 259)) break lab14
            lab15: {
              const v_10: number = this.c
              lab16: {
                if (!this.out_grouping(g_v, 97, 259)) break lab16
                if (!this.go_out_grouping(g_v, 97, 259)) break lab16
                this.c++
                break lab15
              }
              this.c = v_10
              if (!this.in_grouping(g_v, 97, 259)) break lab14
              if (!this.go_in_grouping(g_v, 97, 259)) break lab14
              this.c++
            }
            break lab13
          }
          this.c = v_9
          if (!this.out_grouping(g_v, 97, 259)) break lab12
          lab17: {
            const v_11: number = this.c
            lab18: {
              if (!this.out_grouping(g_v, 97, 259)) break lab18
              if (!this.go_out_grouping(g_v, 97, 259)) break lab18
              this.c++
              break lab17
            }
            this.c = v_11
            if (!this.in_grouping(g_v, 97, 259)) break lab12
            if (this.c >= this.limit) break lab12
            this.c++
          }
        }
        I_pV = this.c
      }
      this.c = v_8
      const v_12: number = this.c
      lab19: {
        if (!this.go_out_grouping(g_v, 97, 259)) break lab19
        this.c++
        if (!this.go_in_grouping(g_v, 97, 259)) break lab19
        this.c++
        I_p1 = this.c
        if (!this.go_out_grouping(g_v, 97, 259)) break lab19
        this.c++
        if (!this.go_in_grouping(g_v, 97, 259)) break lab19
        this.c++
        I_p2 = this.c
      }
      this.c = v_12
    }
    this.limit_backward = this.c
    this.c = this.limit
    const v_13: number = this.limit - this.c
    lab20: {
      this.ket = this.c
      a = this.find_among_b(a_2)
      if (a === 0) break lab20
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p1 > this.c)) break lab20
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          this.slice_from('a')
          break
        }
        case 3: {
          this.slice_from('e')
          break
        }
        case 4: {
          this.slice_from('i')
          break
        }
        case 5: {
          lab21: {
            if (!this.eq_s_b('ab')) break lab21
            break lab20
          }
          this.slice_from('i')
          break
        }
        case 6: {
          this.slice_from('at')
          break
        }
        case 7: {
          this.slice_from('a\u021Bi')
          break
        }
      }
    }
    this.c = this.limit - v_13
    const v_14: number = this.limit - this.c
    lab22: {
      B_standard_suffix_removed = false
      while (true) {
        const v_15: number = this.limit - this.c
        lab23: {
          const v_16: number = this.limit - this.c
          this.ket = this.c
          a = this.find_among_b(a_3)
          if (a === 0) break lab23
          this.bra = this.c
          if (/**@type {boolean}*/ (I_p1 > this.c)) break lab23
          this.slice_from(as_3[a - 1])
          B_standard_suffix_removed = true
          this.c = this.limit - v_16
          continue
        }
        this.c = this.limit - v_15
        break
      }
      this.ket = this.c
      a = this.find_among_b(a_4)
      if (a === 0) break lab22
      this.bra = this.c
      if (/**@type {boolean}*/ (I_p2 > this.c)) break lab22
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          if (!this.eq_s_b('\u021B')) break lab22
          this.bra = this.c
          this.slice_from('t')
          break
        }
        case 3: {
          this.slice_from('ist')
          break
        }
      }
      B_standard_suffix_removed = true
    }
    this.c = this.limit - v_14
    const v_17: number = this.limit - this.c
    lab24: {
      lab25: {
        lab26: {
          if (!B_standard_suffix_removed) break lab26
          break lab25
        }
        if (this.c < I_pV) break lab24
        const v_18: number = this.limit_backward
        this.limit_backward = I_pV
        this.ket = this.c
        a = this.find_among_b(a_5)
        if (a === 0) {
          this.limit_backward = v_18
          break lab24
        }
        this.bra = this.c
        switch (a) {
          case 1: {
            lab27: {
              lab28: {
                if (!this.out_grouping_b(g_v, 97, 259)) break lab28
                break lab27
              }
              if (!this.eq_s_b('u')) {
                this.limit_backward = v_18
                break lab24
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
        this.limit_backward = v_18
      }
    }
    this.c = this.limit - v_17
    const v_19: number = this.limit - this.c
    lab29: {
      this.ket = this.c
      if (this.find_among_b(a_6) === 0) break lab29
      this.bra = this.c
      if (/**@type {boolean}*/ (I_pV > this.c)) break lab29
      this.slice_del()
    }
    this.c = this.limit - v_19
    this.c = this.limit_backward
    const v_20: number = this.c
    while (true) {
      const v_21: number = this.c
      lab31: {
        this.bra = this.c
        a = this.find_among(a_1)
        this.ket = this.c
        switch (a) {
          case 1: {
            this.slice_from('i')
            break
          }
          case 2: {
            this.slice_from('u')
            break
          }
          case 3: {
            if (this.c >= this.limit) break lab31
            this.c++
            break
          }
        }
        continue
      }
      this.c = v_21
      break
    }
    this.c = v_20
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new RomanianStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'daf797aac5310bd4'
