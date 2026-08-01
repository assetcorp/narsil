/*
 * Generated from algorithms/finnish.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision cd95cb543801a620
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['pa', 1],
  ['sti', 2],
  ['kaan', 1],
  ['han', 1],
  ['kin', 1],
  ['h\u00E4n', 1],
  ['k\u00E4\u00E4n', 1],
  ['ko', 1],
  ['p\u00E4', 1],
  ['k\u00F6', 1],
]

const a_1: Among[] = [
  ['lla', -1],
  ['na', -1],
  ['ssa', -1],
  ['ta', -1],
  ['lta', -1, 1],
  ['sta', -1, 2],
]

const a_2: Among[] = [
  ['ll\u00E4', -1],
  ['n\u00E4', -1],
  ['ss\u00E4', -1],
  ['t\u00E4', -1],
  ['lt\u00E4', -1, 1],
  ['st\u00E4', -1, 2],
]

const a_3: Among[] = [
  ['lle', -1],
  ['ine', -1],
]

const a_4: Among[] = [
  ['nsa', 3],
  ['mme', 3],
  ['nne', 3],
  ['ni', 2],
  ['si', 1],
  ['an', 4],
  ['en', 6],
  ['\u00E4n', 5],
  ['ns\u00E4', 3],
]

const a_5: Among[] = [
  ['aa', -1],
  ['ee', -1],
  ['ii', -1],
  ['oo', -1],
  ['uu', -1],
  ['\u00E4\u00E4', -1],
  ['\u00F6\u00F6', -1],
]

const a_6: Among[] = [
  ["'", -1],
  ['ai', -1],
  ['ei', -1],
  ['ii', -1],
  ['oi', -1],
  ['ui', -1],
  ['\u00E4i', -1],
  ['\u00F6i', -1],
]

const a_7: Among[] = [
  ['a', 2],
  ['lla', -1, 1],
  ['na', -1, 2],
  ['ssa', -1, 3],
  ['ta', -1, 4],
  ['lta', -1, 1],
  ['sta', -1, 2],
  ['tta', 3, 3],
  ['lle', -1],
  ['ine', -1],
  ['ksi', -1],
  ['n', 1],
  ['han', -1, 1, 3],
  ['den', -1, 2, 8],
  ['seen', -1, 3, 9],
  ['hen', -1, 4, 4],
  ['tten', -1, 5, 8],
  ['hin', -1, 6, 5],
  ['siin', -1, 7, 8],
  ['hon', -1, 8, 6],
  ['hun', -1, 9, 7],
  ['h\u00E4n', -1, 10, 1],
  ['h\u00F6n', -1, 11, 2],
  ['\u00E4', 2],
  ['ll\u00E4', -1, 1],
  ['n\u00E4', -1, 2],
  ['ss\u00E4', -1, 3],
  ['t\u00E4', -1, 4],
  ['lt\u00E4', -1, 1],
  ['st\u00E4', -1, 2],
  ['tt\u00E4', 3, 3],
]

const a_8: Among[] = [
  ['eja', -1],
  ['mma', 1],
  ['imma', -1, 1],
  ['mpa', 1],
  ['impa', -1, 1],
  ['mmi', 1],
  ['immi', -1, 1],
  ['mpi', 1],
  ['impi', -1, 1],
  ['ej\u00E4', -1],
  ['mm\u00E4', 1],
  ['imm\u00E4', -1, 1],
  ['mp\u00E4', 1],
  ['imp\u00E4', -1, 1],
]

const a_9: Among[] = [
  ['i', -1],
  ['j', -1],
]

const a_10: Among[] = [
  ['mma', 1],
  ['imma', -1, 1],
]

const g_AEI: number[] = [17, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8]

const g_C: number[] = [119, 223, 119, 1]

const g_v: number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32]

const g_particle_end: number[] = [17, 97, 24, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32]

export class FinnishStemmer extends BaseStemmer {
  #af_7(): boolean {
    switch (this.af) {
      case 1:
        return this.#r_A_()
      case 2:
        return this.#r_O_()
      case 3:
        return this.#r_A()
      case 4:
        return this.#r_E()
      case 5:
        return this.#r_I()
      case 6:
        return this.#r_O()
      case 7:
        return this.#r_U()
      case 8:
        return this.#r_VI()
      case 9:
        return this.#r_LV()
    }
    return false
  }

  #r_LV(): boolean {
    return this.find_among_b(a_5) !== 0
  }

  #r_VI(): boolean {
    return this.find_among_b(a_6) !== 0
  }

  #r_A(): boolean {
    lab0: {
      lab1: {
        if (!this.eq_s_b('a')) break lab1
        break lab0
      }
      if (!this.eq_s_b("'")) return false
    }
    return true
  }

  #r_E(): boolean {
    lab0: {
      lab1: {
        if (!this.eq_s_b('e')) break lab1
        break lab0
      }
      if (!this.eq_s_b("'")) return false
    }
    return true
  }

  #r_I(): boolean {
    lab0: {
      lab1: {
        if (!this.eq_s_b('i')) break lab1
        break lab0
      }
      if (!this.eq_s_b("'")) return false
    }
    return true
  }

  #r_O(): boolean {
    lab0: {
      lab1: {
        if (!this.eq_s_b('o')) break lab1
        break lab0
      }
      if (!this.eq_s_b("'")) return false
    }
    return true
  }

  #r_U(): boolean {
    lab0: {
      lab1: {
        if (!this.eq_s_b('u')) break lab1
        break lab0
      }
      if (!this.eq_s_b("'")) return false
    }
    return true
  }

  #r_A_(): boolean {
    lab0: {
      lab1: {
        if (!this.eq_s_b('\u00E4')) break lab1
        break lab0
      }
      if (!this.eq_s_b("'")) return false
    }
    return true
  }

  #r_O_(): boolean {
    lab0: {
      lab1: {
        if (!this.eq_s_b('\u00F6')) break lab1
        break lab0
      }
      lab2: {
        if (!this.eq_s_b('\u00F8')) break lab2
        break lab0
      }
      if (!this.eq_s_b("'")) return false
    }
    return true
  }

  #stem(): boolean {
    let a: number
    let B_ending_removed: boolean
    let S_x: string
    let I_p2: number
    let I_p1: number
    const v_1: number = this.c
    lab0: {
      I_p1 = this.limit
      I_p2 = this.limit
      if (!this.go_out_grouping(g_v, 97, 246)) break lab0
      this.c++
      if (!this.go_in_grouping(g_v, 97, 246)) break lab0
      this.c++
      I_p1 = this.c
      if (!this.go_out_grouping(g_v, 97, 246)) break lab0
      this.c++
      if (!this.go_in_grouping(g_v, 97, 246)) break lab0
      this.c++
      I_p2 = this.c
    }
    this.c = v_1
    B_ending_removed = false
    this.limit_backward = this.c
    this.c = this.limit
    const v_2: number = this.limit - this.c
    lab1: {
      if (this.c < I_p1) break lab1
      const v_3: number = this.limit_backward
      this.limit_backward = I_p1
      this.ket = this.c
      a = this.find_among_b(a_0)
      if (a === 0) {
        this.limit_backward = v_3
        break lab1
      }
      this.bra = this.c
      this.limit_backward = v_3
      switch (a) {
        case 1: {
          if (!this.in_grouping_b(g_particle_end, 97, 246)) break lab1
          break
        }
        case 2: {
          if (/**@type {boolean}*/ (I_p2 > this.c)) break lab1
          break
        }
      }
      this.slice_del()
    }
    this.c = this.limit - v_2
    const v_4: number = this.limit - this.c
    lab2: {
      if (this.c < I_p1) break lab2
      const v_5: number = this.limit_backward
      this.limit_backward = I_p1
      this.ket = this.c
      a = this.find_among_b(a_4)
      if (a === 0) {
        this.limit_backward = v_5
        break lab2
      }
      this.bra = this.c
      this.limit_backward = v_5
      switch (a) {
        case 1: {
          lab3: {
            if (!this.eq_s_b('k')) break lab3
            break lab2
          }
          this.slice_del()
          break
        }
        case 2: {
          this.slice_del()
          this.ket = this.c
          if (!this.eq_s_b('kse')) break lab2
          this.bra = this.c
          this.slice_from('ksi')
          break
        }
        case 3: {
          this.slice_del()
          break
        }
        case 4: {
          if (this.find_among_b(a_1) === 0) break lab2
          this.slice_del()
          break
        }
        case 5: {
          if (this.find_among_b(a_2) === 0) break lab2
          this.slice_del()
          break
        }
        case 6: {
          if (this.find_among_b(a_3) === 0) break lab2
          this.slice_del()
          break
        }
      }
    }
    this.c = this.limit - v_4
    const v_6: number = this.limit - this.c
    lab4: {
      if (this.c < I_p1) break lab4
      const v_7: number = this.limit_backward
      this.limit_backward = I_p1
      this.ket = this.c
      a = this.find_among_b(a_7, this.#af_7)
      if (a === 0) {
        this.limit_backward = v_7
        break lab4
      }
      this.bra = this.c
      this.limit_backward = v_7
      switch (a) {
        case 1: {
          const v_8: number = this.limit - this.c
          lab5: {
            const v_9: number = this.limit - this.c
            lab6: {
              const v_10: number = this.limit - this.c
              lab7: {
                if (!this.#r_LV()) break lab7
                break lab6
              }
              this.c = this.limit - v_10
              if (!this.eq_s_b('ie')) {
                this.c = this.limit - v_8
                break lab5
              }
            }
            this.c = this.limit - v_9
            if (this.c <= this.limit_backward) {
              this.c = this.limit - v_8
              break lab5
            }
            this.c--
            this.bra = this.c
          }
          break
        }
        case 2: {
          if (!this.in_grouping_b(g_v, 97, 246)) break lab4
          if (!this.in_grouping_b(g_C, 98, 122)) break lab4
          break
        }
        case 3: {
          if (!this.eq_s_b('e')) break lab4
          break
        }
      }
      this.slice_del()
      B_ending_removed = true
    }
    this.c = this.limit - v_6
    const v_11: number = this.limit - this.c
    lab8: {
      if (this.c < I_p2) break lab8
      const v_12: number = this.limit_backward
      this.limit_backward = I_p2
      this.ket = this.c
      a = this.find_among_b(a_8)
      if (a === 0) {
        this.limit_backward = v_12
        break lab8
      }
      this.bra = this.c
      this.limit_backward = v_12
      switch (a) {
        case 1: {
          lab9: {
            if (!this.eq_s_b('po')) break lab9
            break lab8
          }
          break
        }
      }
      this.slice_del()
    }
    this.c = this.limit - v_11
    lab10: {
      lab11: {
        if (!B_ending_removed) break lab11
        const v_13: number = this.limit - this.c
        lab12: {
          if (this.c < I_p1) break lab12
          const v_14: number = this.limit_backward
          this.limit_backward = I_p1
          this.ket = this.c
          if (this.find_among_b(a_9) === 0) {
            this.limit_backward = v_14
            break lab12
          }
          this.bra = this.c
          this.limit_backward = v_14
          this.slice_del()
        }
        this.c = this.limit - v_13
        break lab10
      }
      const v_15: number = this.limit - this.c
      lab13: {
        if (this.c < I_p1) break lab13
        const v_16: number = this.limit_backward
        this.limit_backward = I_p1
        this.ket = this.c
        if (!this.eq_s_b('t')) {
          this.limit_backward = v_16
          break lab13
        }
        this.bra = this.c
        const v_17: number = this.limit - this.c
        if (!this.in_grouping_b(g_v, 97, 246)) {
          this.limit_backward = v_16
          break lab13
        }
        this.c = this.limit - v_17
        this.slice_del()
        this.limit_backward = v_16
        if (this.c < I_p2) break lab13
        const v_18: number = this.limit_backward
        this.limit_backward = I_p2
        this.ket = this.c
        a = this.find_among_b(a_10)
        if (a === 0) {
          this.limit_backward = v_18
          break lab13
        }
        this.bra = this.c
        this.limit_backward = v_18
        switch (a) {
          case 1: {
            lab14: {
              if (!this.eq_s_b('po')) break lab14
              break lab13
            }
            break
          }
        }
        this.slice_del()
      }
      this.c = this.limit - v_15
    }
    const v_19: number = this.limit - this.c
    lab15: {
      if (this.c < I_p1) break lab15
      const v_20: number = this.limit_backward
      this.limit_backward = I_p1
      const v_21: number = this.limit - this.c
      lab16: {
        const v_22: number = this.limit - this.c
        if (!this.#r_LV()) break lab16
        this.c = this.limit - v_22
        this.ket = this.c
        if (this.c <= this.limit_backward) break lab16
        this.c--
        this.bra = this.c
        this.slice_del()
      }
      this.c = this.limit - v_21
      const v_23: number = this.limit - this.c
      lab17: {
        this.ket = this.c
        if (!this.in_grouping_b(g_AEI, 97, 228)) break lab17
        this.bra = this.c
        if (!this.in_grouping_b(g_C, 98, 122)) break lab17
        this.slice_del()
      }
      this.c = this.limit - v_23
      const v_24: number = this.limit - this.c
      lab18: {
        this.ket = this.c
        if (!this.eq_s_b('j')) break lab18
        this.bra = this.c
        lab19: {
          lab20: {
            if (!this.eq_s_b('o')) break lab20
            break lab19
          }
          if (!this.eq_s_b('u')) break lab18
        }
        this.slice_del()
      }
      this.c = this.limit - v_24
      const v_25: number = this.limit - this.c
      lab21: {
        this.ket = this.c
        if (!this.eq_s_b('o')) break lab21
        this.bra = this.c
        if (!this.eq_s_b('j')) break lab21
        this.slice_del()
      }
      this.c = this.limit - v_25
      this.limit_backward = v_20
      const v_26: number = this.limit - this.c
      lab22: {
        if (!this.go_in_grouping_b(g_v, 97, 246)) break lab22
        this.ket = this.c
        if (!this.in_grouping_b(g_C, 98, 122)) break lab22
        this.bra = this.c
        S_x = this.slice_to()
        if (!this.eq_s_b(S_x)) break lab22
        this.slice_del()
      }
      this.c = this.limit - v_26
      this.ket = this.c
      if (!this.eq_s_b("'")) break lab15
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_19
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new FinnishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'cd95cb543801a620'
