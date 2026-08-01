/*
 * Generated from algorithms/italian.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision c4d2339182390e18
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ["all'", -1],
  ["d'", -1],
  ["dall'", -1],
  ["dell'", -1],
  ["gl'", -1],
  ["l'", -1],
  ["m'", -1],
  ["nell'", -1],
  ["quell'", -1],
  ["quest'", -1],
  ["s'", -1],
  ["sull'", -1],
  ["t'", -1],
  ["tutt'", -1],
  ["un'", -1],
  ["v'", -1],
]

const a_1: Among[] = [
  ['', 7],
  ['qu', 6, 1],
  ['\u00E1', 1, 2],
  ['\u00E9', 2, 3],
  ['\u00ED', 3, 4],
  ['\u00F3', 4, 5],
  ['\u00FA', 5, 6],
]

const a_2: Among[] = [
  ['', 3],
  ['I', 1, 1],
  ['U', 2, 2],
]

const a_3: Among[] = [
  ['la', -1],
  ['cela', -1, 1],
  ['gliela', -1, 2],
  ['mela', -1, 3],
  ['tela', -1, 4],
  ['vela', -1, 5],
  ['le', -1],
  ['cele', -1, 1],
  ['gliele', -1, 2],
  ['mele', -1, 3],
  ['tele', -1, 4],
  ['vele', -1, 5],
  ['ne', -1],
  ['cene', -1, 1],
  ['gliene', -1, 2],
  ['mene', -1, 3],
  ['sene', -1, 4],
  ['tene', -1, 5],
  ['vene', -1, 6],
  ['ci', -1],
  ['li', -1],
  ['celi', -1, 1],
  ['glieli', -1, 2],
  ['meli', -1, 3],
  ['teli', -1, 4],
  ['veli', -1, 5],
  ['gli', -1, 6],
  ['mi', -1],
  ['si', -1],
  ['ti', -1],
  ['vi', -1],
  ['lo', -1],
  ['celo', -1, 1],
  ['glielo', -1, 2],
  ['melo', -1, 3],
  ['telo', -1, 4],
  ['velo', -1, 5],
]

const a_4: Among[] = [
  ['ando', 1],
  ['endo', 1],
  ['ar', 2],
  ['er', 2],
  ['ir', 2],
]

const as_4: string[] = ['', 'e']

const a_5: Among[] = [
  ['ic', -1],
  ['abil', -1],
  ['os', -1],
  ['iv', 1],
]

const a_6: Among[] = [
  ['ic', 1],
  ['abil', 1],
  ['iv', 1],
]

const a_7: Among[] = [
  ['ica', 1],
  ['logia', 3],
  ['osa', 1],
  ['ista', 1],
  ['iva', 9],
  ['anza', 1],
  ['enza', 5],
  ['ice', 1],
  ['atrice', 1, 1],
  ['iche', 1],
  ['logie', 3],
  ['abile', 1],
  ['ibile', 1],
  ['usione', 4],
  ['azione', 2],
  ['uzione', 4],
  ['atore', 2],
  ['ose', 1],
  ['ante', 1],
  ['mente', 1],
  ['amente', 7, 1],
  ['iste', 1],
  ['ive', 9],
  ['anze', 1],
  ['enze', 5],
  ['ici', 1],
  ['atrici', 1, 1],
  ['ichi', 1],
  ['abili', 1],
  ['ibili', 1],
  ['ismi', 1],
  ['usioni', 4],
  ['azioni', 2],
  ['uzioni', 4],
  ['atori', 2],
  ['osi', 1],
  ['anti', 1],
  ['amenti', 6],
  ['imenti', 6],
  ['isti', 1],
  ['ivi', 9],
  ['ico', 1],
  ['ismo', 1],
  ['oso', 1],
  ['amento', 6],
  ['imento', 6],
  ['ivo', 9],
  ['it\u00E0', 8],
  ['ist\u00E0', 1],
  ['ist\u00E8', 1],
  ['ist\u00EC', 1],
]

const a_8: Among[] = [
  ['isca', 1],
  ['enda', 1],
  ['ata', 1],
  ['ita', 1],
  ['uta', 1],
  ['ava', 1],
  ['eva', 1],
  ['iva', 1],
  ['erebbe', 1],
  ['irebbe', 1],
  ['isce', 1],
  ['ende', 1],
  ['are', 1],
  ['ere', 1],
  ['ire', 1],
  ['asse', 1],
  ['ate', 1],
  ['avate', 1, 1],
  ['evate', 1, 2],
  ['ivate', 1, 3],
  ['ete', 1],
  ['erete', 1, 1],
  ['irete', 1, 2],
  ['ite', 1],
  ['ereste', 1],
  ['ireste', 1],
  ['ute', 1],
  ['erai', 1],
  ['irai', 1],
  ['isci', 1],
  ['endi', 1],
  ['erei', 1],
  ['irei', 1],
  ['assi', 1],
  ['ati', 1],
  ['iti', 1],
  ['eresti', 1],
  ['iresti', 1],
  ['uti', 1],
  ['avi', 1],
  ['evi', 1],
  ['ivi', 1],
  ['isco', 1],
  ['ando', 1],
  ['endo', 1],
  ['Yamo', 1],
  ['iamo', 1],
  ['avamo', 1],
  ['evamo', 1],
  ['ivamo', 1],
  ['eremo', 1],
  ['iremo', 1],
  ['assimo', 1],
  ['ammo', 1],
  ['emmo', 1],
  ['eremmo', 1, 1],
  ['iremmo', 1, 2],
  ['immo', 1],
  ['ano', 1],
  ['iscano', 1, 1],
  ['avano', 1, 2],
  ['evano', 1, 3],
  ['ivano', 1, 4],
  ['eranno', 1],
  ['iranno', 1],
  ['ono', 1],
  ['iscono', 1, 1],
  ['arono', 1, 2],
  ['erono', 1, 3],
  ['irono', 1, 4],
  ['erebbero', 1],
  ['irebbero', 1],
  ['assero', 1],
  ['essero', 1],
  ['issero', 1],
  ['ato', 1],
  ['ito', 1],
  ['uto', 1],
  ['avo', 1],
  ['evo', 1],
  ['ivo', 1],
  ['ar', 1],
  ['ir', 1],
  ['er\u00E0', 1],
  ['ir\u00E0', 1],
  ['er\u00F2', 1],
  ['ir\u00F2', 1],
]

const g_v: number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 8, 2, 1]

const g_AEIO: number[] = [17, 65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 8, 2]

const g_CG: number[] = [17]

export class ItalianStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let I_p2: number
    let I_p1: number
    let I_pV: number
    const v_1: number = this.c
    lab0: {
      this.bra = this.c
      if (this.find_among(a_0) === 0) break lab0
      this.ket = this.c
      if (/**@type {boolean}*/ (this.c >= this.limit)) break lab0
      this.slice_del()
    }
    this.c = v_1
    const v_2: number = this.c
    {
      const v_3: number = this.c
      while (true) {
        const v_4: number = this.c
        lab2: {
          this.bra = this.c
          a = this.find_among(a_1)
          this.ket = this.c
          switch (a) {
            case 1: {
              this.slice_from('\u00E0')
              break
            }
            case 2: {
              this.slice_from('\u00E8')
              break
            }
            case 3: {
              this.slice_from('\u00EC')
              break
            }
            case 4: {
              this.slice_from('\u00F2')
              break
            }
            case 5: {
              this.slice_from('\u00F9')
              break
            }
            case 6: {
              this.slice_from('qU')
              break
            }
            case 7: {
              if (this.c >= this.limit) break lab2
              this.c++
              break
            }
          }
          continue
        }
        this.c = v_4
        break
      }
      this.c = v_3
      while (true) {
        const v_5: number = this.c
        lab3: {
          while (true) {
            const v_6: number = this.c
            lab5: {
              if (!this.in_grouping(g_v, 97, 249)) break lab5
              this.bra = this.c
              lab6: {
                const v_7: number = this.c
                lab7: {
                  if (!this.eq_s('u')) break lab7
                  this.ket = this.c
                  if (!this.in_grouping(g_v, 97, 249)) break lab7
                  this.slice_from('U')
                  break lab6
                }
                this.c = v_7
                if (!this.eq_s('i')) break lab5
                this.ket = this.c
                if (!this.in_grouping(g_v, 97, 249)) break lab5
                this.slice_from('I')
              }
              this.c = v_6
              break
            }
            this.c = v_6
            if (this.c >= this.limit) break lab3
            this.c++
          }
          continue
        }
        this.c = v_5
        break
      }
    }
    this.c = v_2
    {
      I_pV = this.limit
      I_p1 = this.limit
      I_p2 = this.limit
      const v_8: number = this.c
      lab9: {
        lab10: {
          const v_9: number = this.c
          lab11: {
            if (!this.in_grouping(g_v, 97, 249)) break lab11
            lab12: {
              const v_10: number = this.c
              lab13: {
                if (!this.out_grouping(g_v, 97, 249)) break lab13
                if (!this.go_out_grouping(g_v, 97, 249)) break lab13
                this.c++
                break lab12
              }
              this.c = v_10
              if (!this.in_grouping(g_v, 97, 249)) break lab11
              if (!this.go_in_grouping(g_v, 97, 249)) break lab11
              this.c++
            }
            break lab10
          }
          this.c = v_9
          lab14: {
            if (!this.eq_s('divan')) break lab14
            break lab10
          }
          this.c = v_9
          if (!this.out_grouping(g_v, 97, 249)) break lab9
          lab15: {
            const v_11: number = this.c
            lab16: {
              if (!this.out_grouping(g_v, 97, 249)) break lab16
              if (!this.go_out_grouping(g_v, 97, 249)) break lab16
              this.c++
              break lab15
            }
            this.c = v_11
            if (!this.in_grouping(g_v, 97, 249)) break lab9
            if (this.c >= this.limit) break lab9
            this.c++
          }
        }
        I_pV = this.c
      }
      this.c = v_8
      const v_12: number = this.c
      lab17: {
        if (!this.go_out_grouping(g_v, 97, 249)) break lab17
        this.c++
        if (!this.go_in_grouping(g_v, 97, 249)) break lab17
        this.c++
        I_p1 = this.c
        if (!this.go_out_grouping(g_v, 97, 249)) break lab17
        this.c++
        if (!this.go_in_grouping(g_v, 97, 249)) break lab17
        this.c++
        I_p2 = this.c
      }
      this.c = v_12
    }
    this.limit_backward = this.c
    this.c = this.limit
    const v_13: number = this.limit - this.c
    lab18: {
      this.ket = this.c
      if (this.find_among_b(a_3) === 0) break lab18
      this.bra = this.c
      a = this.find_among_b(a_4)
      if (a === 0) break lab18
      if (/**@type {boolean}*/ (I_pV > this.c)) break lab18
      this.slice_from(as_4[a - 1])
    }
    this.c = this.limit - v_13
    const v_14: number = this.limit - this.c
    lab19: {
      lab20: {
        const v_15: number = this.limit - this.c
        lab21: {
          this.ket = this.c
          a = this.find_among_b(a_7)
          if (a === 0) break lab21
          this.bra = this.c
          switch (a) {
            case 1: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
              this.slice_del()
              break
            }
            case 2: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
              this.slice_del()
              const v_16: number = this.limit - this.c
              lab22: {
                this.ket = this.c
                if (!this.eq_s_b('ic')) {
                  this.c = this.limit - v_16
                  break lab22
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_16
                  break lab22
                }
                this.slice_del()
              }
              break
            }
            case 3: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
              this.slice_from('log')
              break
            }
            case 4: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
              this.slice_from('u')
              break
            }
            case 5: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
              this.slice_from('ente')
              break
            }
            case 6: {
              if (/**@type {boolean}*/ (I_pV > this.c)) break lab21
              this.slice_del()
              break
            }
            case 7: {
              if (/**@type {boolean}*/ (I_p1 > this.c)) break lab21
              this.slice_del()
              const v_17: number = this.limit - this.c
              lab23: {
                this.ket = this.c
                a = this.find_among_b(a_5)
                if (a === 0) {
                  this.c = this.limit - v_17
                  break lab23
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_17
                  break lab23
                }
                this.slice_del()
                switch (a) {
                  case 1: {
                    this.ket = this.c
                    if (!this.eq_s_b('at')) {
                      this.c = this.limit - v_17
                      break lab23
                    }
                    this.bra = this.c
                    if (/**@type {boolean}*/ (I_p2 > this.c)) {
                      this.c = this.limit - v_17
                      break lab23
                    }
                    this.slice_del()
                    break
                  }
                }
              }
              break
            }
            case 8: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
              this.slice_del()
              const v_18: number = this.limit - this.c
              lab24: {
                this.ket = this.c
                if (this.find_among_b(a_6) === 0) {
                  this.c = this.limit - v_18
                  break lab24
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_18
                  break lab24
                }
                this.slice_del()
              }
              break
            }
            case 9: {
              if (/**@type {boolean}*/ (I_p2 > this.c)) break lab21
              this.slice_del()
              const v_19: number = this.limit - this.c
              lab25: {
                this.ket = this.c
                if (!this.eq_s_b('at')) {
                  this.c = this.limit - v_19
                  break lab25
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_19
                  break lab25
                }
                this.slice_del()
                this.ket = this.c
                if (!this.eq_s_b('ic')) {
                  this.c = this.limit - v_19
                  break lab25
                }
                this.bra = this.c
                if (/**@type {boolean}*/ (I_p2 > this.c)) {
                  this.c = this.limit - v_19
                  break lab25
                }
                this.slice_del()
              }
              break
            }
          }
          break lab20
        }
        this.c = this.limit - v_15
        if (this.c < I_pV) break lab19
        const v_20: number = this.limit_backward
        this.limit_backward = I_pV
        this.ket = this.c
        if (this.find_among_b(a_8) === 0) {
          this.limit_backward = v_20
          break lab19
        }
        this.bra = this.c
        this.slice_del()
        this.limit_backward = v_20
      }
    }
    this.c = this.limit - v_14
    const v_21: number = this.limit - this.c
    {
      const v_22: number = this.limit - this.c
      lab27: {
        this.ket = this.c
        if (!this.in_grouping_b(g_AEIO, 97, 242)) {
          this.c = this.limit - v_22
          break lab27
        }
        this.bra = this.c
        if (/**@type {boolean}*/ (I_pV > this.c)) {
          this.c = this.limit - v_22
          break lab27
        }
        this.slice_del()
        this.ket = this.c
        if (!this.eq_s_b('i')) {
          this.c = this.limit - v_22
          break lab27
        }
        this.bra = this.c
        if (/**@type {boolean}*/ (I_pV > this.c)) {
          this.c = this.limit - v_22
          break lab27
        }
        this.slice_del()
      }
      const v_23: number = this.limit - this.c
      lab28: {
        this.ket = this.c
        if (!this.eq_s_b('h')) {
          this.c = this.limit - v_23
          break lab28
        }
        this.bra = this.c
        if (!this.in_grouping_b(g_CG, 99, 103)) {
          this.c = this.limit - v_23
          break lab28
        }
        if (/**@type {boolean}*/ (I_pV > this.c)) {
          this.c = this.limit - v_23
          break lab28
        }
        this.slice_del()
      }
    }
    this.c = this.limit - v_21
    this.c = this.limit_backward
    const v_24: number = this.c
    while (true) {
      const v_25: number = this.c
      lab30: {
        this.bra = this.c
        a = this.find_among(a_2)
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
            if (this.c >= this.limit) break lab30
            this.c++
            break
          }
        }
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

const shared = new ItalianStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'c4d2339182390e18'
