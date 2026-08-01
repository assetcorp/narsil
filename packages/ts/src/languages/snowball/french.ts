/*
 * Generated from algorithms/french.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 240a93ad04b96326
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['col', -1],
  ['ni', 1],
  ['par', -1],
  ['tap', -1],
]

const a_1: Among[] = [
  ['', 7],
  ['H', 6, 1],
  ['He', 4, 1],
  ['Hi', 5, 2],
  ['I', 1, 4],
  ['U', 2, 5],
  ['Y', 3, 6],
]

const a_2: Among[] = [
  ['iqU', 3],
  ['abl', 3],
  ['I\u00E8r', 4],
  ['i\u00E8r', 4],
  ['eus', 2],
  ['iv', 1],
]

const a_3: Among[] = [
  ['ic', 2],
  ['abil', 1],
  ['iv', 3],
]

const a_4: Among[] = [
  ['iqUe', 1],
  ['atrice', 2],
  ['ance', 1],
  ['ence', 5],
  ['logie', 3],
  ['able', 1],
  ['isme', 1],
  ['euse', 12],
  ['iste', 1],
  ['ive', 8],
  ['if', 8],
  ['usion', 4],
  ['ation', 2],
  ['ution', 4],
  ['ateur', 2],
  ['iqUes', 1],
  ['atrices', 2],
  ['ances', 1],
  ['ences', 5],
  ['logies', 3],
  ['ables', 1],
  ['ismes', 1],
  ['euses', 12],
  ['istes', 1],
  ['ives', 8],
  ['ifs', 8],
  ['usions', 4],
  ['ations', 2],
  ['utions', 4],
  ['ateurs', 2],
  ['ments', 16],
  ['ements', 6, 1],
  ['issements', 13, 1],
  ['it\u00E9s', 7],
  ['ment', 16],
  ['ement', 6, 1],
  ['issement', 13, 1],
  ['amment', 14, 3],
  ['emment', 15, 4],
  ['aux', 10],
  ['eaux', 9, 1],
  ['eux', 1],
  ['oux', 11],
  ['it\u00E9', 7],
]

const a_5: Among[] = [
  ['ira', 1],
  ['ie', 1],
  ['isse', 1],
  ['issante', 1],
  ['i', 1],
  ['irai', 1, 1],
  ['ir', 1],
  ['iras', 1],
  ['ies', 1],
  ['\u00EEmes', 1],
  ['isses', 1],
  ['issantes', 1],
  ['\u00EEtes', 1],
  ['is', 1],
  ['irais', 1, 1],
  ['issais', 1, 2],
  ['irions', 1],
  ['issions', 1],
  ['irons', 1],
  ['issons', 1],
  ['issants', 1],
  ['it', 1],
  ['irait', 1, 1],
  ['issait', 1, 2],
  ['issant', 1],
  ['iraIent', 1],
  ['issaIent', 1],
  ['irent', 1],
  ['issent', 1],
  ['iront', 1],
  ['\u00EEt', 1],
  ['iriez', 1],
  ['issiez', 1],
  ['irez', 1],
  ['issez', 1],
]

const a_6: Among[] = [
  ['al', 1],
  ['\u00E9pl', -1],
  ['auv', -1],
]

const a_7: Among[] = [
  ['a', 3],
  ['era', 2, 1],
  ['aise', 4],
  ['asse', 3],
  ['ante', 3],
  ['\u00E9e', 2],
  ['ai', 3],
  ['erai', 2, 1],
  ['er', 2],
  ['as', 3],
  ['eras', 2, 1],
  ['\u00E2mes', 3],
  ['aises', 4],
  ['asses', 3],
  ['antes', 3],
  ['\u00E2tes', 3],
  ['\u00E9es', 2],
  ['ais', 4],
  ['eais', 2, 1],
  ['erais', 2, 2],
  ['ions', 1],
  ['erions', 2, 1],
  ['assions', 3, 2],
  ['erons', 2],
  ['ants', 3],
  ['\u00E9s', 2],
  ['ait', 3],
  ['erait', 2, 1],
  ['ant', 3],
  ['aIent', 3],
  ['eraIent', 2, 1],
  ['\u00E8rent', 2],
  ['assent', 3],
  ['eront', 2],
  ['\u00E2t', 3],
  ['ez', 2],
  ['iez', 2, 1],
  ['eriez', 2, 1],
  ['assiez', 3, 2],
  ['erez', 2, 4],
  ['\u00E9', 2],
]

const a_8: Among[] = [
  ['e', 3],
  ['I\u00E8re', 2, 1],
  ['i\u00E8re', 2, 2],
  ['ion', 1],
  ['Ier', 2],
  ['ier', 2],
]

const a_9: Among[] = [
  ['ell', -1],
  ['eill', -1],
  ['enn', -1],
  ['onn', -1],
  ['ett', -1],
]

const g_v: number[] = [17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 130, 103, 8, 5]

const g_oux_ending: number[] = [65, 85]

const g_elision_char: number[] = [131, 14, 3]

const g_keep_with_s: number[] = [1, 65, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128]

export class FrenchStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let I_p2: number
    let I_p1: number
    let I_pV: number
    const v_1: number = this.c
    lab0: {
      this.bra = this.c
      lab1: {
        lab2: {
          if (!this.in_grouping(g_elision_char, 99, 116)) break lab2
          break lab1
        }
        if (!this.eq_s('qu')) break lab0
      }
      if (!this.eq_s("'")) break lab0
      this.ket = this.c
      if (/**@type {boolean}*/ (this.c >= this.limit)) break lab0
      this.slice_del()
    }
    this.c = v_1
    const v_2: number = this.c
    while (true) {
      const v_3: number = this.c
      lab4: {
        while (true) {
          const v_4: number = this.c
          lab6: {
            lab7: {
              const v_5: number = this.c
              lab8: {
                if (!this.in_grouping(g_v, 97, 251)) break lab8
                this.bra = this.c
                lab9: {
                  const v_6: number = this.c
                  lab10: {
                    if (!this.eq_s('u')) break lab10
                    this.ket = this.c
                    if (!this.in_grouping(g_v, 97, 251)) break lab10
                    this.slice_from('U')
                    break lab9
                  }
                  this.c = v_6
                  lab11: {
                    if (!this.eq_s('i')) break lab11
                    this.ket = this.c
                    if (!this.in_grouping(g_v, 97, 251)) break lab11
                    this.slice_from('I')
                    break lab9
                  }
                  this.c = v_6
                  if (!this.eq_s('y')) break lab8
                  this.ket = this.c
                  this.slice_from('Y')
                }
                break lab7
              }
              this.c = v_5
              lab12: {
                this.bra = this.c
                if (!this.eq_s('\u00EB')) break lab12
                this.ket = this.c
                this.slice_from('He')
                break lab7
              }
              this.c = v_5
              lab13: {
                this.bra = this.c
                if (!this.eq_s('\u00EF')) break lab13
                this.ket = this.c
                this.slice_from('Hi')
                break lab7
              }
              this.c = v_5
              lab14: {
                this.bra = this.c
                if (!this.eq_s('y')) break lab14
                this.ket = this.c
                if (!this.in_grouping(g_v, 97, 251)) break lab14
                this.slice_from('Y')
                break lab7
              }
              this.c = v_5
              if (!this.eq_s('q')) break lab6
              this.bra = this.c
              if (!this.eq_s('u')) break lab6
              this.ket = this.c
              this.slice_from('U')
            }
            this.c = v_4
            break
          }
          this.c = v_4
          if (this.c >= this.limit) break lab4
          this.c++
        }
        continue
      }
      this.c = v_3
      break
    }
    this.c = v_2
    {
      I_pV = this.limit
      I_p1 = this.limit
      I_p2 = this.limit
      const v_7: number = this.c
      lab16: {
        lab17: {
          const v_8: number = this.c
          lab18: {
            if (!this.in_grouping(g_v, 97, 251)) break lab18
            if (!this.in_grouping(g_v, 97, 251)) break lab18
            if (this.c >= this.limit) break lab18
            this.c++
            break lab17
          }
          this.c = v_8
          lab19: {
            a = this.find_among(a_0)
            if (a === 0) break lab19
            switch (a) {
              case 1: {
                if (!this.in_grouping(g_v, 97, 251)) break lab19
                break
              }
            }
            break lab17
          }
          this.c = v_8
          if (this.c >= this.limit) break lab16
          this.c++
          if (!this.go_out_grouping(g_v, 97, 251)) break lab16
          this.c++
        }
        I_pV = this.c
      }
      this.c = v_7
      const v_9: number = this.c
      lab20: {
        if (!this.go_out_grouping(g_v, 97, 251)) break lab20
        this.c++
        if (!this.go_in_grouping(g_v, 97, 251)) break lab20
        this.c++
        I_p1 = this.c
        if (!this.go_out_grouping(g_v, 97, 251)) break lab20
        this.c++
        if (!this.go_in_grouping(g_v, 97, 251)) break lab20
        this.c++
        I_p2 = this.c
      }
      this.c = v_9
    }
    this.limit_backward = this.c
    this.c = this.limit
    const v_10: number = this.limit - this.c
    lab21: {
      lab22: {
        const v_11: number = this.limit - this.c
        lab23: {
          const v_12: number = this.limit - this.c
          lab24: {
            const v_13: number = this.limit - this.c
            lab25: {
              this.ket = this.c
              a = this.find_among_b(a_4)
              if (a === 0) break lab25
              this.bra = this.c
              switch (a) {
                case 1: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab25
                  this.slice_del()
                  break
                }
                case 2: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab25
                  this.slice_del()
                  const v_14: number = this.limit - this.c
                  lab26: {
                    this.ket = this.c
                    if (!this.eq_s_b('ic')) {
                      this.c = this.limit - v_14
                      break lab26
                    }
                    this.bra = this.c
                    lab27: {
                      const v_15: number = this.limit - this.c
                      lab28: {
                        if (/**@type {boolean}*/ (I_p2 > this.c)) break lab28
                        this.slice_del()
                        break lab27
                      }
                      this.c = this.limit - v_15
                      this.slice_from('iqU')
                    }
                  }
                  break
                }
                case 3: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab25
                  this.slice_from('log')
                  break
                }
                case 4: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab25
                  this.slice_from('u')
                  break
                }
                case 5: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab25
                  this.slice_from('ent')
                  break
                }
                case 6: {
                  if (/**@type {boolean}*/ (I_pV > this.c)) break lab25
                  this.slice_del()
                  const v_16: number = this.limit - this.c
                  lab29: {
                    this.ket = this.c
                    a = this.find_among_b(a_2)
                    if (a === 0) {
                      this.c = this.limit - v_16
                      break lab29
                    }
                    this.bra = this.c
                    switch (a) {
                      case 1: {
                        if (/**@type {boolean}*/ (I_p2 > this.c)) {
                          this.c = this.limit - v_16
                          break lab29
                        }
                        this.slice_del()
                        this.ket = this.c
                        if (!this.eq_s_b('at')) {
                          this.c = this.limit - v_16
                          break lab29
                        }
                        this.bra = this.c
                        if (/**@type {boolean}*/ (I_p2 > this.c)) {
                          this.c = this.limit - v_16
                          break lab29
                        }
                        this.slice_del()
                        break
                      }
                      case 2: {
                        lab30: {
                          const v_17: number = this.limit - this.c
                          lab31: {
                            if (/**@type {boolean}*/ (I_p2 > this.c)) break lab31
                            this.slice_del()
                            break lab30
                          }
                          this.c = this.limit - v_17
                          if (/**@type {boolean}*/ (I_p1 > this.c)) {
                            this.c = this.limit - v_16
                            break lab29
                          }
                          this.slice_from('eux')
                        }
                        break
                      }
                      case 3: {
                        if (/**@type {boolean}*/ (I_p2 > this.c)) {
                          this.c = this.limit - v_16
                          break lab29
                        }
                        this.slice_del()
                        break
                      }
                      case 4: {
                        if (/**@type {boolean}*/ (I_pV > this.c)) {
                          this.c = this.limit - v_16
                          break lab29
                        }
                        this.slice_from('i')
                        break
                      }
                    }
                  }
                  break
                }
                case 7: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab25
                  this.slice_del()
                  const v_18: number = this.limit - this.c
                  lab32: {
                    this.ket = this.c
                    a = this.find_among_b(a_3)
                    if (a === 0) {
                      this.c = this.limit - v_18
                      break lab32
                    }
                    this.bra = this.c
                    switch (a) {
                      case 1: {
                        lab33: {
                          const v_19: number = this.limit - this.c
                          lab34: {
                            if (/**@type {boolean}*/ (I_p2 > this.c)) break lab34
                            this.slice_del()
                            break lab33
                          }
                          this.c = this.limit - v_19
                          this.slice_from('abl')
                        }
                        break
                      }
                      case 2: {
                        lab35: {
                          const v_20: number = this.limit - this.c
                          lab36: {
                            if (/**@type {boolean}*/ (I_p2 > this.c)) break lab36
                            this.slice_del()
                            break lab35
                          }
                          this.c = this.limit - v_20
                          this.slice_from('iqU')
                        }
                        break
                      }
                      case 3: {
                        if (/**@type {boolean}*/ (I_p2 > this.c)) {
                          this.c = this.limit - v_18
                          break lab32
                        }
                        this.slice_del()
                        break
                      }
                    }
                  }
                  break
                }
                case 8: {
                  if (/**@type {boolean}*/ (I_p2 > this.c)) break lab25
                  this.slice_del()
                  const v_21: number = this.limit - this.c
                  lab37: {
                    this.ket = this.c
                    if (!this.eq_s_b('at')) {
                      this.c = this.limit - v_21
                      break lab37
                    }
                    this.bra = this.c
                    if (/**@type {boolean}*/ (I_p2 > this.c)) {
                      this.c = this.limit - v_21
                      break lab37
                    }
                    this.slice_del()
                    this.ket = this.c
                    if (!this.eq_s_b('ic')) {
                      this.c = this.limit - v_21
                      break lab37
                    }
                    this.bra = this.c
                    lab38: {
                      const v_22: number = this.limit - this.c
                      lab39: {
                        if (/**@type {boolean}*/ (I_p2 > this.c)) break lab39
                        this.slice_del()
                        break lab38
                      }
                      this.c = this.limit - v_22
                      this.slice_from('iqU')
                    }
                  }
                  break
                }
                case 9: {
                  this.slice_from('eau')
                  break
                }
                case 10: {
                  if (/**@type {boolean}*/ (I_p1 > this.c)) break lab25
                  this.slice_from('al')
                  break
                }
                case 11: {
                  if (!this.in_grouping_b(g_oux_ending, 98, 112)) break lab25
                  this.slice_from('ou')
                  break
                }
                case 12: {
                  lab40: {
                    const v_23: number = this.limit - this.c
                    lab41: {
                      if (/**@type {boolean}*/ (I_p2 > this.c)) break lab41
                      this.slice_del()
                      break lab40
                    }
                    this.c = this.limit - v_23
                    if (/**@type {boolean}*/ (I_p1 > this.c)) break lab25
                    this.slice_from('eux')
                  }
                  break
                }
                case 13: {
                  if (/**@type {boolean}*/ (I_p1 > this.c)) break lab25
                  if (!this.out_grouping_b(g_v, 97, 251)) break lab25
                  this.slice_del()
                  break
                }
                case 14: {
                  if (/**@type {boolean}*/ (I_pV > this.c)) break lab25
                  this.slice_from('ant')
                  break lab25
                }
                case 15: {
                  if (/**@type {boolean}*/ (I_pV > this.c)) break lab25
                  this.slice_from('ent')
                  break lab25
                }
                case 16: {
                  const v_24: number = this.limit - this.c
                  if (!this.in_grouping_b(g_v, 97, 251)) break lab25
                  if (/**@type {boolean}*/ (I_pV > this.c)) break lab25
                  this.c = this.limit - v_24
                  this.slice_del()
                  break lab25
                }
              }
              break lab24
            }
            this.c = this.limit - v_13
            lab42: {
              if (this.c < I_pV) break lab42
              const v_25: number = this.limit_backward
              this.limit_backward = I_pV
              this.ket = this.c
              if (this.find_among_b(a_5) === 0) {
                this.limit_backward = v_25
                break lab42
              }
              this.bra = this.c
              lab43: {
                if (!this.eq_s_b('H')) break lab43
                this.limit_backward = v_25
                break lab42
              }
              if (!this.out_grouping_b(g_v, 97, 251)) {
                this.limit_backward = v_25
                break lab42
              }
              this.slice_del()
              this.limit_backward = v_25
              break lab24
            }
            this.c = this.limit - v_13
            if (this.c < I_pV) break lab23
            const v_26: number = this.limit_backward
            this.limit_backward = I_pV
            this.ket = this.c
            a = this.find_among_b(a_7)
            if (a === 0) {
              this.limit_backward = v_26
              break lab23
            }
            this.bra = this.c
            this.limit_backward = v_26
            switch (a) {
              case 1: {
                if (/**@type {boolean}*/ (I_p2 > this.c)) break lab23
                this.slice_del()
                break
              }
              case 2: {
                this.slice_del()
                break
              }
              case 3: {
                const v_27: number = this.limit - this.c
                lab44: {
                  if (!this.eq_s_b('e')) {
                    this.c = this.limit - v_27
                    break lab44
                  }
                  if (/**@type {boolean}*/ (I_pV > this.c)) {
                    this.c = this.limit - v_27
                    break lab44
                  }
                  this.bra = this.c
                }
                this.slice_del()
                break
              }
              case 4: {
                {
                  const v_28: number = this.limit - this.c
                  lab45: {
                    a = this.find_among_b(a_6)
                    if (a === 0) break lab45
                    switch (a) {
                      case 1: {
                        if (this.c <= this.limit_backward) break lab45
                        this.c--
                        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab45
                        break
                      }
                    }
                    break lab23
                  }
                  this.c = this.limit - v_28
                }
                this.slice_del()
                break
              }
            }
          }
          this.c = this.limit - v_12
          const v_29: number = this.limit - this.c
          lab46: {
            this.ket = this.c
            lab47: {
              const v_30: number = this.limit - this.c
              lab48: {
                if (!this.eq_s_b('Y')) break lab48
                this.bra = this.c
                this.slice_from('i')
                break lab47
              }
              this.c = this.limit - v_30
              if (!this.eq_s_b('\u00E7')) {
                this.c = this.limit - v_29
                break lab46
              }
              this.bra = this.c
              this.slice_from('c')
            }
          }
          break lab22
        }
        this.c = this.limit - v_11
        const v_31: number = this.limit - this.c
        lab49: {
          this.ket = this.c
          if (!this.eq_s_b('s')) {
            this.c = this.limit - v_31
            break lab49
          }
          this.bra = this.c
          const v_32: number = this.limit - this.c
          lab50: {
            lab51: {
              if (!this.eq_s_b('Hi')) break lab51
              break lab50
            }
            if (!this.out_grouping_b(g_keep_with_s, 97, 232)) {
              this.c = this.limit - v_31
              break lab49
            }
          }
          this.c = this.limit - v_32
          this.slice_del()
        }
        if (this.c < I_pV) break lab21
        const v_33: number = this.limit_backward
        this.limit_backward = I_pV
        this.ket = this.c
        a = this.find_among_b(a_8)
        if (a === 0) {
          this.limit_backward = v_33
          break lab21
        }
        this.bra = this.c
        switch (a) {
          case 1: {
            if (/**@type {boolean}*/ (I_p2 > this.c)) {
              this.limit_backward = v_33
              break lab21
            }
            lab52: {
              lab53: {
                if (!this.eq_s_b('s')) break lab53
                break lab52
              }
              if (!this.eq_s_b('t')) {
                this.limit_backward = v_33
                break lab21
              }
            }
            this.slice_del()
            break
          }
          case 2: {
            this.slice_from('i')
            break
          }
          case 3: {
            this.slice_del()
            break
          }
        }
        this.limit_backward = v_33
      }
    }
    this.c = this.limit - v_10
    const v_34: number = this.limit - this.c
    lab54: {
      const v_35: number = this.limit - this.c
      if (this.find_among_b(a_9) === 0) break lab54
      this.c = this.limit - v_35
      this.ket = this.c
      if (this.c <= this.limit_backward) break lab54
      this.c--
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_34
    const v_36: number = this.limit - this.c
    lab55: {
      {
        let v_37 = 1
        while (true) {
          lab56: {
            if (!this.out_grouping_b(g_v, 97, 251)) break lab56
            v_37--
            continue
          }
          break
        }
        if (v_37 > 0) break lab55
      }
      this.ket = this.c
      lab57: {
        lab58: {
          if (!this.eq_s_b('\u00E9')) break lab58
          break lab57
        }
        if (!this.eq_s_b('\u00E8')) break lab55
      }
      this.bra = this.c
      this.slice_from('e')
    }
    this.c = this.limit - v_36
    this.c = this.limit_backward
    const v_38: number = this.c
    while (true) {
      const v_39: number = this.c
      lab60: {
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
            this.slice_from('y')
            break
          }
          case 4: {
            this.slice_from('\u00EB')
            break
          }
          case 5: {
            this.slice_from('\u00EF')
            break
          }
          case 6: {
            this.slice_del()
            break
          }
          case 7: {
            if (this.c >= this.limit) break lab60
            this.c++
            break
          }
        }
        continue
      }
      this.c = v_39
      break
    }
    this.c = v_38
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new FrenchStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '240a93ad04b96326'
