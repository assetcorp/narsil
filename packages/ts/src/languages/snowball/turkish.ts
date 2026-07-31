/*
 * Generated from algorithms/turkish.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision c537dbdae6350a3c
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['m', -1],
  ['n', -1],
  ['miz', -1],
  ['niz', -1],
  ['muz', -1],
  ['nuz', -1],
  ['m\u00FCz', -1],
  ['n\u00FCz', -1],
  ['m\u0131z', -1],
  ['n\u0131z', -1],
]

const a_1: Among[] = [
  ['leri', -1],
  ['lar\u0131', -1],
]

const a_2: Among[] = [
  ['ni', -1],
  ['nu', -1],
  ['n\u00FC', -1],
  ['n\u0131', -1],
]

const a_3: Among[] = [
  ['in', -1],
  ['un', -1],
  ['\u00FCn', -1],
  ['\u0131n', -1],
]

const a_4: Among[] = [
  ['a', -1],
  ['e', -1],
]

const a_5: Among[] = [
  ['na', -1],
  ['ne', -1],
]

const a_6: Among[] = [
  ['da', -1],
  ['ta', -1],
  ['de', -1],
  ['te', -1],
]

const a_7: Among[] = [
  ['nda', -1],
  ['nde', -1],
]

const a_8: Among[] = [
  ['dan', -1],
  ['tan', -1],
  ['den', -1],
  ['ten', -1],
]

const a_9: Among[] = [
  ['ndan', -1],
  ['nden', -1],
]

const a_10: Among[] = [
  ['la', -1],
  ['le', -1],
]

const a_11: Among[] = [
  ['ca', -1],
  ['ce', -1],
]

const a_12: Among[] = [
  ['im', -1],
  ['um', -1],
  ['\u00FCm', -1],
  ['\u0131m', -1],
]

const a_13: Among[] = [
  ['sin', -1],
  ['sun', -1],
  ['s\u00FCn', -1],
  ['s\u0131n', -1],
]

const a_14: Among[] = [
  ['iz', -1],
  ['uz', -1],
  ['\u00FCz', -1],
  ['\u0131z', -1],
]

const a_15: Among[] = [
  ['siniz', -1],
  ['sunuz', -1],
  ['s\u00FCn\u00FCz', -1],
  ['s\u0131n\u0131z', -1],
]

const a_16: Among[] = [
  ['lar', -1],
  ['ler', -1],
]

const a_17: Among[] = [
  ['niz', -1],
  ['nuz', -1],
  ['n\u00FCz', -1],
  ['n\u0131z', -1],
]

const a_18: Among[] = [
  ['dir', -1],
  ['tir', -1],
  ['dur', -1],
  ['tur', -1],
  ['d\u00FCr', -1],
  ['t\u00FCr', -1],
  ['d\u0131r', -1],
  ['t\u0131r', -1],
]

const a_19: Among[] = [
  ['cas\u0131na', -1],
  ['cesine', -1],
]

const a_20: Among[] = [
  ['di', -1],
  ['ti', -1],
  ['dik', -1],
  ['tik', -1],
  ['duk', -1],
  ['tuk', -1],
  ['d\u00FCk', -1],
  ['t\u00FCk', -1],
  ['d\u0131k', -1],
  ['t\u0131k', -1],
  ['dim', -1],
  ['tim', -1],
  ['dum', -1],
  ['tum', -1],
  ['d\u00FCm', -1],
  ['t\u00FCm', -1],
  ['d\u0131m', -1],
  ['t\u0131m', -1],
  ['din', -1],
  ['tin', -1],
  ['dun', -1],
  ['tun', -1],
  ['d\u00FCn', -1],
  ['t\u00FCn', -1],
  ['d\u0131n', -1],
  ['t\u0131n', -1],
  ['du', -1],
  ['tu', -1],
  ['d\u00FC', -1],
  ['t\u00FC', -1],
  ['d\u0131', -1],
  ['t\u0131', -1],
]

const a_21: Among[] = [
  ['sa', -1],
  ['se', -1],
  ['sak', -1],
  ['sek', -1],
  ['sam', -1],
  ['sem', -1],
  ['san', -1],
  ['sen', -1],
]

const a_22: Among[] = [
  ['mi\u015F', -1],
  ['mu\u015F', -1],
  ['m\u00FC\u015F', -1],
  ['m\u0131\u015F', -1],
]

const a_23: Among[] = [
  ['b', 1],
  ['c', 2],
  ['d', 3],
  ['\u011F', 4],
]

const as_23: string[] = ['p', '\u00E7', 't', 'k']

const g_vowel: number[] = [17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 8, 0, 0, 0, 0, 0, 0, 1]

const g_U: number[] = [1, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 1]

const g_vowel1: number[] = [1, 64, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]

const g_vowel2: number[] = [17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 130]

const g_vowel3: number[] = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]

const g_vowel4: number[] = [17]

const g_vowel5: number[] = [65]

const g_vowel6: number[] = [65]

export class TurkishStemmer extends BaseStemmer {
  #r_check_vowel_harmony(): boolean {
    const v_1: number = this.limit - this.c
    if (!this.go_out_grouping_b(g_vowel, 97, 305)) return false
    lab0: {
      const v_2: number = this.limit - this.c
      lab1: {
        if (!this.eq_s_b('a')) break lab1
        if (!this.go_out_grouping_b(g_vowel1, 97, 305)) break lab1
        break lab0
      }
      this.c = this.limit - v_2
      lab2: {
        if (!this.eq_s_b('e')) break lab2
        if (!this.go_out_grouping_b(g_vowel2, 101, 252)) break lab2
        break lab0
      }
      this.c = this.limit - v_2
      lab3: {
        if (!this.eq_s_b('\u0131')) break lab3
        if (!this.go_out_grouping_b(g_vowel3, 97, 305)) break lab3
        break lab0
      }
      this.c = this.limit - v_2
      lab4: {
        if (!this.eq_s_b('i')) break lab4
        if (!this.go_out_grouping_b(g_vowel4, 101, 105)) break lab4
        break lab0
      }
      this.c = this.limit - v_2
      lab5: {
        if (!this.eq_s_b('o')) break lab5
        if (!this.go_out_grouping_b(g_vowel5, 111, 117)) break lab5
        break lab0
      }
      this.c = this.limit - v_2
      lab6: {
        if (!this.eq_s_b('\u00F6')) break lab6
        if (!this.go_out_grouping_b(g_vowel6, 246, 252)) break lab6
        break lab0
      }
      this.c = this.limit - v_2
      lab7: {
        if (!this.eq_s_b('u')) break lab7
        if (!this.go_out_grouping_b(g_vowel5, 111, 117)) break lab7
        break lab0
      }
      this.c = this.limit - v_2
      if (!this.eq_s_b('\u00FC')) return false
      if (!this.go_out_grouping_b(g_vowel6, 246, 252)) return false
    }
    this.c = this.limit - v_1
    return true
  }

  #r_mark_suffix_with_optional_n_consonant(): boolean {
    lab0: {
      const v_1: number = this.limit - this.c
      lab1: {
        if (!this.eq_s_b('n')) break lab1
        const v_2: number = this.limit - this.c
        if (!this.in_grouping_b(g_vowel, 97, 305)) break lab1
        this.c = this.limit - v_2
        break lab0
      }
      this.c = this.limit - v_1
      lab2: {
        if (!this.eq_s_b('n')) break lab2
        return false
      }
      const v_3: number = this.limit - this.c
      if (this.c <= this.limit_backward) return false
      this.c--
      if (!this.in_grouping_b(g_vowel, 97, 305)) return false
      this.c = this.limit - v_3
    }
    return true
  }

  #r_mark_suffix_with_optional_y_consonant(): boolean {
    lab0: {
      const v_1: number = this.limit - this.c
      lab1: {
        if (!this.eq_s_b('y')) break lab1
        const v_2: number = this.limit - this.c
        if (!this.in_grouping_b(g_vowel, 97, 305)) break lab1
        this.c = this.limit - v_2
        break lab0
      }
      this.c = this.limit - v_1
      lab2: {
        if (!this.eq_s_b('y')) break lab2
        return false
      }
      const v_3: number = this.limit - this.c
      if (this.c <= this.limit_backward) return false
      this.c--
      if (!this.in_grouping_b(g_vowel, 97, 305)) return false
      this.c = this.limit - v_3
    }
    return true
  }

  #r_mark_possessives(): boolean {
    if (this.find_among_b(a_0) === 0) return false
    lab0: {
      const v_1: number = this.limit - this.c
      lab1: {
        if (!this.in_grouping_b(g_U, 105, 305)) break lab1
        const v_2: number = this.limit - this.c
        if (!this.out_grouping_b(g_vowel, 97, 305)) break lab1
        this.c = this.limit - v_2
        break lab0
      }
      this.c = this.limit - v_1
      lab2: {
        if (!this.in_grouping_b(g_U, 105, 305)) break lab2
        return false
      }
      const v_3: number = this.limit - this.c
      if (this.c <= this.limit_backward) return false
      this.c--
      if (!this.out_grouping_b(g_vowel, 97, 305)) return false
      this.c = this.limit - v_3
    }
    return true
  }

  #r_mark_sU(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    if (!this.in_grouping_b(g_U, 105, 305)) return false
    lab0: {
      const v_1: number = this.limit - this.c
      lab1: {
        if (!this.eq_s_b('s')) break lab1
        const v_2: number = this.limit - this.c
        if (!this.in_grouping_b(g_vowel, 97, 305)) break lab1
        this.c = this.limit - v_2
        break lab0
      }
      this.c = this.limit - v_1
      lab2: {
        if (!this.eq_s_b('s')) break lab2
        return false
      }
      const v_3: number = this.limit - this.c
      if (this.c <= this.limit_backward) return false
      this.c--
      if (!this.in_grouping_b(g_vowel, 97, 305)) return false
      this.c = this.limit - v_3
    }
    return true
  }

  #r_mark_lArI(): boolean {
    return this.find_among_b(a_1) !== 0
  }

  #r_mark_nUn(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    if (this.find_among_b(a_3) === 0) return false
    return this.#r_mark_suffix_with_optional_n_consonant()
  }

  #r_mark_DA(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    return this.find_among_b(a_6) !== 0
  }

  #r_mark_ndA(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    return this.find_among_b(a_7) !== 0
  }

  #r_mark_yUm(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    if (this.find_among_b(a_12) === 0) return false
    return this.#r_mark_suffix_with_optional_y_consonant()
  }

  #r_mark_sUn(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    return this.find_among_b(a_13) !== 0
  }

  #r_mark_yUz(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    if (this.find_among_b(a_14) === 0) return false
    return this.#r_mark_suffix_with_optional_y_consonant()
  }

  #r_mark_sUnUz(): boolean {
    return this.find_among_b(a_15) !== 0
  }

  #r_mark_lAr(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    return this.find_among_b(a_16) !== 0
  }

  #r_mark_DUr(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    return this.find_among_b(a_18) !== 0
  }

  #r_mark_yDU(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    if (this.find_among_b(a_20) === 0) return false
    return this.#r_mark_suffix_with_optional_y_consonant()
  }

  #r_mark_ysA(): boolean {
    if (this.find_among_b(a_21) === 0) return false
    return this.#r_mark_suffix_with_optional_y_consonant()
  }

  #r_mark_ymUs_(): boolean {
    if (!this.#r_check_vowel_harmony()) return false
    if (this.find_among_b(a_22) === 0) return false
    return this.#r_mark_suffix_with_optional_y_consonant()
  }

  #r_stem_suffix_chain_before_ki(): boolean {
    this.ket = this.c
    if (!this.eq_s_b('ki')) return false
    lab0: {
      const v_1: number = this.limit - this.c
      lab1: {
        if (!this.#r_mark_DA()) break lab1
        this.bra = this.c
        this.slice_del()
        const v_2: number = this.limit - this.c
        lab2: {
          this.ket = this.c
          lab3: {
            const v_3: number = this.limit - this.c
            lab4: {
              if (!this.#r_mark_lAr()) break lab4
              this.bra = this.c
              this.slice_del()
              const v_4: number = this.limit - this.c
              lab5: {
                if (!this.#r_stem_suffix_chain_before_ki()) {
                  this.c = this.limit - v_4
                  break lab5
                }
              }
              break lab3
            }
            this.c = this.limit - v_3
            if (!this.#r_mark_possessives()) {
              this.c = this.limit - v_2
              break lab2
            }
            this.bra = this.c
            this.slice_del()
            const v_5: number = this.limit - this.c
            lab6: {
              this.ket = this.c
              if (!this.#r_mark_lAr()) {
                this.c = this.limit - v_5
                break lab6
              }
              this.bra = this.c
              this.slice_del()
              if (!this.#r_stem_suffix_chain_before_ki()) {
                this.c = this.limit - v_5
                break lab6
              }
            }
          }
        }
        break lab0
      }
      this.c = this.limit - v_1
      lab7: {
        if (!this.#r_mark_nUn()) break lab7
        this.bra = this.c
        this.slice_del()
        const v_6: number = this.limit - this.c
        lab8: {
          this.ket = this.c
          lab9: {
            const v_7: number = this.limit - this.c
            lab10: {
              if (!this.#r_mark_lArI()) break lab10
              this.bra = this.c
              this.slice_del()
              break lab9
            }
            this.c = this.limit - v_7
            lab11: {
              this.ket = this.c
              lab12: {
                const v_8: number = this.limit - this.c
                lab13: {
                  if (!this.#r_mark_possessives()) break lab13
                  break lab12
                }
                this.c = this.limit - v_8
                if (!this.#r_mark_sU()) break lab11
              }
              this.bra = this.c
              this.slice_del()
              const v_9: number = this.limit - this.c
              lab14: {
                this.ket = this.c
                if (!this.#r_mark_lAr()) {
                  this.c = this.limit - v_9
                  break lab14
                }
                this.bra = this.c
                this.slice_del()
                if (!this.#r_stem_suffix_chain_before_ki()) {
                  this.c = this.limit - v_9
                  break lab14
                }
              }
              break lab9
            }
            this.c = this.limit - v_7
            if (!this.#r_stem_suffix_chain_before_ki()) {
              this.c = this.limit - v_6
              break lab8
            }
          }
        }
        break lab0
      }
      this.c = this.limit - v_1
      if (!this.#r_mark_ndA()) return false
      lab15: {
        const v_10: number = this.limit - this.c
        lab16: {
          if (!this.#r_mark_lArI()) break lab16
          this.bra = this.c
          this.slice_del()
          break lab15
        }
        this.c = this.limit - v_10
        lab17: {
          if (!this.#r_mark_sU()) break lab17
          this.bra = this.c
          this.slice_del()
          const v_11: number = this.limit - this.c
          lab18: {
            this.ket = this.c
            if (!this.#r_mark_lAr()) {
              this.c = this.limit - v_11
              break lab18
            }
            this.bra = this.c
            this.slice_del()
            if (!this.#r_stem_suffix_chain_before_ki()) {
              this.c = this.limit - v_11
              break lab18
            }
          }
          break lab15
        }
        this.c = this.limit - v_10
        if (!this.#r_stem_suffix_chain_before_ki()) return false
      }
    }
    return true
  }

  #stem(): boolean {
    let a: number
    let B_continue_stemming_noun_suffixes: boolean
    {
      const v_1: number = this.c
      lab1: {
        this.bra = this.c
        while (true) {
          const v_2: number = this.c
          lab3: {
            lab4: {
              if (!this.eq_s("'")) break lab4
              break lab3
            }
            this.c = v_2
            break
          }
          this.c = v_2
          if (this.c >= this.limit) break lab1
          this.c++
        }
        this.ket = this.c
        this.slice_del()
      }
      this.c = v_1
      const v_3: number = this.c
      lab5: {
        if (this.c + 2 > this.limit) break lab5
        this.c += 2
        while (true) {
          const v_4: number = this.c
          lab7: {
            if (!this.eq_s("'")) break lab7
            this.c = v_4
            break
          }
          this.c = v_4
          if (this.c >= this.limit) break lab5
          this.c++
        }
        this.bra = this.c
        this.c = this.limit
        this.ket = this.c
        this.slice_del()
      }
      this.c = v_3
    }
    const v_5: number = this.c
    for (let v_6: number = 2; v_6 > 0; v_6--) {
      if (!this.go_out_grouping(g_vowel, 97, 305)) return false
      this.c++
    }
    this.c = v_5
    this.limit_backward = this.c
    this.c = this.limit
    const v_7: number = this.limit - this.c
    lab8: {
      this.ket = this.c
      B_continue_stemming_noun_suffixes = true
      lab9: {
        const v_8: number = this.limit - this.c
        lab10: {
          lab11: {
            const v_9: number = this.limit - this.c
            lab12: {
              if (!this.#r_mark_ymUs_()) break lab12
              break lab11
            }
            this.c = this.limit - v_9
            lab13: {
              if (!this.#r_mark_yDU()) break lab13
              break lab11
            }
            this.c = this.limit - v_9
            lab14: {
              if (!this.#r_mark_ysA()) break lab14
              break lab11
            }
            this.c = this.limit - v_9
            if (!this.eq_s_b('ken')) break lab10
            if (!this.#r_mark_suffix_with_optional_y_consonant()) break lab10
          }
          break lab9
        }
        this.c = this.limit - v_8
        lab15: {
          if (this.find_among_b(a_19) === 0) break lab15
          lab16: {
            const v_10: number = this.limit - this.c
            lab17: {
              if (!this.#r_mark_sUnUz()) break lab17
              break lab16
            }
            this.c = this.limit - v_10
            lab18: {
              if (!this.#r_mark_lAr()) break lab18
              break lab16
            }
            this.c = this.limit - v_10
            lab19: {
              if (!this.#r_mark_yUm()) break lab19
              break lab16
            }
            this.c = this.limit - v_10
            lab20: {
              if (!this.#r_mark_sUn()) break lab20
              break lab16
            }
            this.c = this.limit - v_10
            lab21: {
              if (!this.#r_mark_yUz()) break lab21
              break lab16
            }
            this.c = this.limit - v_10
          }
          if (!this.#r_mark_ymUs_()) break lab15
          break lab9
        }
        this.c = this.limit - v_8
        lab22: {
          if (!this.#r_mark_lAr()) break lab22
          this.bra = this.c
          this.slice_del()
          const v_11: number = this.limit - this.c
          lab23: {
            this.ket = this.c
            lab24: {
              const v_12: number = this.limit - this.c
              lab25: {
                if (!this.#r_mark_DUr()) break lab25
                break lab24
              }
              this.c = this.limit - v_12
              lab26: {
                if (!this.#r_mark_yDU()) break lab26
                break lab24
              }
              this.c = this.limit - v_12
              lab27: {
                if (!this.#r_mark_ysA()) break lab27
                break lab24
              }
              this.c = this.limit - v_12
              if (!this.#r_mark_ymUs_()) {
                this.c = this.limit - v_11
                break lab23
              }
            }
          }
          B_continue_stemming_noun_suffixes = false
          break lab9
        }
        this.c = this.limit - v_8
        lab28: {
          if (!this.#r_check_vowel_harmony()) break lab28
          if (this.find_among_b(a_17) === 0) break lab28
          lab29: {
            const v_13: number = this.limit - this.c
            lab30: {
              if (!this.#r_mark_yDU()) break lab30
              break lab29
            }
            this.c = this.limit - v_13
            if (!this.#r_mark_ysA()) break lab28
          }
          break lab9
        }
        this.c = this.limit - v_8
        lab31: {
          lab32: {
            const v_14: number = this.limit - this.c
            lab33: {
              if (!this.#r_mark_sUnUz()) break lab33
              break lab32
            }
            this.c = this.limit - v_14
            lab34: {
              if (!this.#r_mark_yUz()) break lab34
              break lab32
            }
            this.c = this.limit - v_14
            lab35: {
              if (!this.#r_mark_sUn()) break lab35
              break lab32
            }
            this.c = this.limit - v_14
            if (!this.#r_mark_yUm()) break lab31
          }
          this.bra = this.c
          this.slice_del()
          const v_15: number = this.limit - this.c
          lab36: {
            this.ket = this.c
            if (!this.#r_mark_ymUs_()) {
              this.c = this.limit - v_15
              break lab36
            }
          }
          break lab9
        }
        this.c = this.limit - v_8
        if (!this.#r_mark_DUr()) break lab8
        this.bra = this.c
        this.slice_del()
        const v_16: number = this.limit - this.c
        lab37: {
          this.ket = this.c
          lab38: {
            const v_17: number = this.limit - this.c
            lab39: {
              if (!this.#r_mark_sUnUz()) break lab39
              break lab38
            }
            this.c = this.limit - v_17
            lab40: {
              if (!this.#r_mark_lAr()) break lab40
              break lab38
            }
            this.c = this.limit - v_17
            lab41: {
              if (!this.#r_mark_yUm()) break lab41
              break lab38
            }
            this.c = this.limit - v_17
            lab42: {
              if (!this.#r_mark_sUn()) break lab42
              break lab38
            }
            this.c = this.limit - v_17
            lab43: {
              if (!this.#r_mark_yUz()) break lab43
              break lab38
            }
            this.c = this.limit - v_17
          }
          if (!this.#r_mark_ymUs_()) {
            this.c = this.limit - v_16
            break lab37
          }
        }
      }
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_7
    if (!B_continue_stemming_noun_suffixes) return false
    const v_18: number = this.limit - this.c
    lab44: {
      lab45: {
        const v_19: number = this.limit - this.c
        lab46: {
          this.ket = this.c
          if (!this.#r_mark_lAr()) break lab46
          this.bra = this.c
          this.slice_del()
          const v_20: number = this.limit - this.c
          lab47: {
            if (!this.#r_stem_suffix_chain_before_ki()) {
              this.c = this.limit - v_20
              break lab47
            }
          }
          break lab45
        }
        this.c = this.limit - v_19
        lab48: {
          this.ket = this.c
          if (!this.#r_check_vowel_harmony()) break lab48
          if (this.find_among_b(a_11) === 0) break lab48
          if (!this.#r_mark_suffix_with_optional_n_consonant()) break lab48
          this.bra = this.c
          this.slice_del()
          const v_21: number = this.limit - this.c
          lab49: {
            lab50: {
              const v_22: number = this.limit - this.c
              lab51: {
                this.ket = this.c
                if (!this.#r_mark_lArI()) break lab51
                this.bra = this.c
                this.slice_del()
                break lab50
              }
              this.c = this.limit - v_22
              lab52: {
                this.ket = this.c
                lab53: {
                  const v_23: number = this.limit - this.c
                  lab54: {
                    if (!this.#r_mark_possessives()) break lab54
                    break lab53
                  }
                  this.c = this.limit - v_23
                  if (!this.#r_mark_sU()) break lab52
                }
                this.bra = this.c
                this.slice_del()
                const v_24: number = this.limit - this.c
                lab55: {
                  this.ket = this.c
                  if (!this.#r_mark_lAr()) {
                    this.c = this.limit - v_24
                    break lab55
                  }
                  this.bra = this.c
                  this.slice_del()
                  if (!this.#r_stem_suffix_chain_before_ki()) {
                    this.c = this.limit - v_24
                    break lab55
                  }
                }
                break lab50
              }
              this.c = this.limit - v_22
              this.ket = this.c
              if (!this.#r_mark_lAr()) {
                this.c = this.limit - v_21
                break lab49
              }
              this.bra = this.c
              this.slice_del()
              if (!this.#r_stem_suffix_chain_before_ki()) {
                this.c = this.limit - v_21
                break lab49
              }
            }
          }
          break lab45
        }
        this.c = this.limit - v_19
        lab56: {
          this.ket = this.c
          lab57: {
            const v_25: number = this.limit - this.c
            lab58: {
              if (!this.#r_mark_ndA()) break lab58
              break lab57
            }
            this.c = this.limit - v_25
            if (!this.#r_check_vowel_harmony()) break lab56
            if (this.find_among_b(a_5) === 0) break lab56
          }
          lab59: {
            const v_26: number = this.limit - this.c
            lab60: {
              if (!this.#r_mark_lArI()) break lab60
              this.bra = this.c
              this.slice_del()
              break lab59
            }
            this.c = this.limit - v_26
            lab61: {
              if (!this.#r_mark_sU()) break lab61
              this.bra = this.c
              this.slice_del()
              const v_27: number = this.limit - this.c
              lab62: {
                this.ket = this.c
                if (!this.#r_mark_lAr()) {
                  this.c = this.limit - v_27
                  break lab62
                }
                this.bra = this.c
                this.slice_del()
                if (!this.#r_stem_suffix_chain_before_ki()) {
                  this.c = this.limit - v_27
                  break lab62
                }
              }
              break lab59
            }
            this.c = this.limit - v_26
            if (!this.#r_stem_suffix_chain_before_ki()) break lab56
          }
          break lab45
        }
        this.c = this.limit - v_19
        lab63: {
          this.ket = this.c
          lab64: {
            const v_28: number = this.limit - this.c
            lab65: {
              if (!this.#r_check_vowel_harmony()) break lab65
              if (this.find_among_b(a_9) === 0) break lab65
              break lab64
            }
            this.c = this.limit - v_28
            if (!this.#r_check_vowel_harmony()) break lab63
            if (this.find_among_b(a_2) === 0) break lab63
          }
          lab66: {
            const v_29: number = this.limit - this.c
            lab67: {
              if (!this.#r_mark_sU()) break lab67
              this.bra = this.c
              this.slice_del()
              const v_30: number = this.limit - this.c
              lab68: {
                this.ket = this.c
                if (!this.#r_mark_lAr()) {
                  this.c = this.limit - v_30
                  break lab68
                }
                this.bra = this.c
                this.slice_del()
                if (!this.#r_stem_suffix_chain_before_ki()) {
                  this.c = this.limit - v_30
                  break lab68
                }
              }
              break lab66
            }
            this.c = this.limit - v_29
            if (!this.#r_mark_lArI()) break lab63
          }
          break lab45
        }
        this.c = this.limit - v_19
        lab69: {
          this.ket = this.c
          if (!this.#r_check_vowel_harmony()) break lab69
          if (this.find_among_b(a_8) === 0) break lab69
          this.bra = this.c
          this.slice_del()
          const v_31: number = this.limit - this.c
          lab70: {
            this.ket = this.c
            lab71: {
              const v_32: number = this.limit - this.c
              lab72: {
                if (!this.#r_mark_possessives()) break lab72
                this.bra = this.c
                this.slice_del()
                const v_33: number = this.limit - this.c
                lab73: {
                  this.ket = this.c
                  if (!this.#r_mark_lAr()) {
                    this.c = this.limit - v_33
                    break lab73
                  }
                  this.bra = this.c
                  this.slice_del()
                  if (!this.#r_stem_suffix_chain_before_ki()) {
                    this.c = this.limit - v_33
                    break lab73
                  }
                }
                break lab71
              }
              this.c = this.limit - v_32
              lab74: {
                if (!this.#r_mark_lAr()) break lab74
                this.bra = this.c
                this.slice_del()
                const v_34: number = this.limit - this.c
                lab75: {
                  if (!this.#r_stem_suffix_chain_before_ki()) {
                    this.c = this.limit - v_34
                    break lab75
                  }
                }
                break lab71
              }
              this.c = this.limit - v_32
              if (!this.#r_stem_suffix_chain_before_ki()) {
                this.c = this.limit - v_31
                break lab70
              }
            }
          }
          break lab45
        }
        this.c = this.limit - v_19
        lab76: {
          this.ket = this.c
          lab77: {
            const v_35: number = this.limit - this.c
            lab78: {
              if (!this.#r_mark_nUn()) break lab78
              break lab77
            }
            this.c = this.limit - v_35
            if (!this.#r_check_vowel_harmony()) break lab76
            if (this.find_among_b(a_10) === 0) break lab76
            if (!this.#r_mark_suffix_with_optional_y_consonant()) break lab76
          }
          this.bra = this.c
          this.slice_del()
          const v_36: number = this.limit - this.c
          lab79: {
            lab80: {
              const v_37: number = this.limit - this.c
              lab81: {
                this.ket = this.c
                if (!this.#r_mark_lAr()) break lab81
                this.bra = this.c
                this.slice_del()
                if (!this.#r_stem_suffix_chain_before_ki()) break lab81
                break lab80
              }
              this.c = this.limit - v_37
              lab82: {
                this.ket = this.c
                lab83: {
                  const v_38: number = this.limit - this.c
                  lab84: {
                    if (!this.#r_mark_possessives()) break lab84
                    break lab83
                  }
                  this.c = this.limit - v_38
                  if (!this.#r_mark_sU()) break lab82
                }
                this.bra = this.c
                this.slice_del()
                const v_39: number = this.limit - this.c
                lab85: {
                  this.ket = this.c
                  if (!this.#r_mark_lAr()) {
                    this.c = this.limit - v_39
                    break lab85
                  }
                  this.bra = this.c
                  this.slice_del()
                  if (!this.#r_stem_suffix_chain_before_ki()) {
                    this.c = this.limit - v_39
                    break lab85
                  }
                }
                break lab80
              }
              this.c = this.limit - v_37
              if (!this.#r_stem_suffix_chain_before_ki()) {
                this.c = this.limit - v_36
                break lab79
              }
            }
          }
          break lab45
        }
        this.c = this.limit - v_19
        lab86: {
          this.ket = this.c
          if (!this.#r_mark_lArI()) break lab86
          this.bra = this.c
          this.slice_del()
          break lab45
        }
        this.c = this.limit - v_19
        lab87: {
          if (!this.#r_stem_suffix_chain_before_ki()) break lab87
          break lab45
        }
        this.c = this.limit - v_19
        lab88: {
          this.ket = this.c
          lab89: {
            const v_40: number = this.limit - this.c
            lab90: {
              if (!this.#r_mark_DA()) break lab90
              break lab89
            }
            this.c = this.limit - v_40
            lab91: {
              if (!this.#r_check_vowel_harmony()) break lab91
              if (!this.in_grouping_b(g_U, 105, 305)) break lab91
              if (!this.#r_mark_suffix_with_optional_y_consonant()) break lab91
              break lab89
            }
            this.c = this.limit - v_40
            if (!this.#r_check_vowel_harmony()) break lab88
            if (this.find_among_b(a_4) === 0) break lab88
            if (!this.#r_mark_suffix_with_optional_y_consonant()) break lab88
          }
          this.bra = this.c
          this.slice_del()
          const v_41: number = this.limit - this.c
          lab92: {
            this.ket = this.c
            lab93: {
              const v_42: number = this.limit - this.c
              lab94: {
                if (!this.#r_mark_possessives()) break lab94
                this.bra = this.c
                this.slice_del()
                const v_43: number = this.limit - this.c
                lab95: {
                  this.ket = this.c
                  if (!this.#r_mark_lAr()) {
                    this.c = this.limit - v_43
                    break lab95
                  }
                }
                break lab93
              }
              this.c = this.limit - v_42
              if (!this.#r_mark_lAr()) {
                this.c = this.limit - v_41
                break lab92
              }
            }
            this.bra = this.c
            this.slice_del()
            this.ket = this.c
            if (!this.#r_stem_suffix_chain_before_ki()) {
              this.c = this.limit - v_41
              break lab92
            }
          }
          break lab45
        }
        this.c = this.limit - v_19
        this.ket = this.c
        lab96: {
          const v_44: number = this.limit - this.c
          lab97: {
            if (!this.#r_mark_possessives()) break lab97
            break lab96
          }
          this.c = this.limit - v_44
          if (!this.#r_mark_sU()) break lab44
        }
        this.bra = this.c
        this.slice_del()
        const v_45: number = this.limit - this.c
        lab98: {
          this.ket = this.c
          if (!this.#r_mark_lAr()) {
            this.c = this.limit - v_45
            break lab98
          }
          this.bra = this.c
          this.slice_del()
          if (!this.#r_stem_suffix_chain_before_ki()) {
            this.c = this.limit - v_45
            break lab98
          }
        }
      }
    }
    this.c = this.limit - v_18
    this.c = this.limit_backward
    this.limit_backward = this.c
    this.c = this.limit
    {
      const v_46: number = this.limit - this.c
      lab99: {
        if (!this.eq_s_b('ad')) break lab99
        const v_47: number = this.limit - this.c
        lab100: {
          if (!this.eq_s_b('soy')) {
            this.c = this.limit - v_47
            break lab100
          }
        }
        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab99
        return false
      }
      this.c = this.limit - v_46
    }
    const v_48: number = this.limit - this.c
    lab101: {
      this.ket = this.c
      this.bra = this.c
      lab102: {
        lab103: {
          if (!this.eq_s_b('d')) break lab103
          break lab102
        }
        if (!this.eq_s_b('g')) break lab101
      }
      if (!this.go_out_grouping_b(g_vowel, 97, 305)) break lab101
      lab104: {
        const v_49: number = this.limit - this.c
        lab105: {
          lab106: {
            lab107: {
              if (!this.eq_s_b('a')) break lab107
              break lab106
            }
            if (!this.eq_s_b('\u0131')) break lab105
          }
          this.slice_from('\u0131')
          break lab104
        }
        this.c = this.limit - v_49
        lab108: {
          lab109: {
            lab110: {
              if (!this.eq_s_b('e')) break lab110
              break lab109
            }
            if (!this.eq_s_b('i')) break lab108
          }
          this.slice_from('i')
          break lab104
        }
        this.c = this.limit - v_49
        lab111: {
          lab112: {
            lab113: {
              if (!this.eq_s_b('o')) break lab113
              break lab112
            }
            if (!this.eq_s_b('u')) break lab111
          }
          this.slice_from('u')
          break lab104
        }
        this.c = this.limit - v_49
        lab114: {
          lab115: {
            if (!this.eq_s_b('\u00F6')) break lab115
            break lab114
          }
          if (!this.eq_s_b('\u00FC')) break lab101
        }
        this.slice_from('\u00FC')
      }
    }
    this.c = this.limit - v_48
    const v_50: number = this.limit - this.c
    lab116: {
      this.ket = this.c
      a = this.find_among_b(a_23)
      if (a === 0) break lab116
      this.bra = this.c
      this.slice_from(as_23[a - 1])
    }
    this.c = this.limit - v_50
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new TurkishStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = 'c537dbdae6350a3c'
