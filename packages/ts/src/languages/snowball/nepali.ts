/*
 * Generated from algorithms/nepali.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 12453388370b3da0
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['\u0932\u093E\u0907', 1],
  ['\u0932\u093E\u0908', 1],
  ['\u0938\u0901\u0917', 1],
  ['\u0938\u0902\u0917', 1],
  ['\u092E\u093E\u0930\u094D\u092B\u0924', 1],
  ['\u0930\u0924', 1],
  ['\u0915\u093E', 2],
  ['\u092E\u093E', 1],
  ['\u0926\u094D\u0935\u093E\u0930\u093E', 1],
  ['\u0915\u093F', 2],
  ['\u092A\u091B\u093F', 1],
  ['\u0915\u0940', 2],
  ['\u0932\u0947', 1],
  ['\u0915\u0948', 2],
  ['\u0938\u0901\u0917\u0948', 1],
  ['\u092E\u0948', 1],
  ['\u0915\u094B', 2],
]

const a_1: Among[] = [
  ['\u0901', 1],
  ['\u0902', 1],
  ['\u0948', 2],
]

const a_2: Among[] = [
  ['\u0925\u093F\u090F', 1],
  ['\u091B', 1],
  ['\u0907\u091B', 1, 1],
  ['\u090F\u091B', 1, 2],
  ['\u093F\u091B', 1, 3],
  ['\u0947\u091B', 1, 4],
  ['\u0928\u0947\u091B', 1, 1],
  ['\u0939\u0941\u0928\u0947\u091B', 1, 1],
  ['\u0907\u0928\u094D\u091B', 1, 7],
  ['\u093F\u0928\u094D\u091B', 1, 8],
  ['\u0939\u0941\u0928\u094D\u091B', 1, 9],
  ['\u090F\u0915\u093E', 1],
  ['\u0907\u090F\u0915\u093E', 1, 1],
  ['\u093F\u090F\u0915\u093E', 1, 2],
  ['\u0947\u0915\u093E', 1],
  ['\u0928\u0947\u0915\u093E', 1, 1],
  ['\u0926\u093E', 1],
  ['\u0907\u0926\u093E', 1, 1],
  ['\u093F\u0926\u093E', 1, 2],
  ['\u0926\u0947\u0916\u093F', 1],
  ['\u092E\u093E\u0925\u093F', 1],
  ['\u090F\u0915\u0940', 1],
  ['\u0907\u090F\u0915\u0940', 1, 1],
  ['\u093F\u090F\u0915\u0940', 1, 2],
  ['\u0947\u0915\u0940', 1],
  ['\u0926\u0947\u0916\u0940', 1],
  ['\u0925\u0940', 1],
  ['\u0926\u0940', 1],
  ['\u091B\u0941', 1],
  ['\u090F\u091B\u0941', 1, 1],
  ['\u0947\u091B\u0941', 1, 2],
  ['\u0928\u0947\u091B\u0941', 1, 1],
  ['\u0928\u0941', 1],
  ['\u0939\u0930\u0941', 1],
  ['\u0939\u0930\u0942', 1],
  ['\u091B\u0947', 1],
  ['\u0925\u0947', 1],
  ['\u0928\u0947', 1],
  ['\u090F\u0915\u0948', 1],
  ['\u0947\u0915\u0948', 1],
  ['\u0928\u0947\u0915\u0948', 1, 1],
  ['\u0926\u0948', 1],
  ['\u0907\u0926\u0948', 1, 1],
  ['\u093F\u0926\u0948', 1, 2],
  ['\u090F\u0915\u094B', 1],
  ['\u0907\u090F\u0915\u094B', 1, 1],
  ['\u093F\u090F\u0915\u094B', 1, 2],
  ['\u0947\u0915\u094B', 1],
  ['\u0928\u0947\u0915\u094B', 1, 1],
  ['\u0926\u094B', 1],
  ['\u0907\u0926\u094B', 1, 1],
  ['\u093F\u0926\u094B', 1, 2],
  ['\u092F\u094B', 1],
  ['\u0907\u092F\u094B', 1, 1],
  ['\u092D\u092F\u094B', 1, 2],
  ['\u093F\u092F\u094B', 1, 3],
  ['\u0925\u093F\u092F\u094B', 1, 1],
  ['\u0926\u093F\u092F\u094B', 1, 2],
  ['\u0925\u094D\u092F\u094B', 1, 6],
  ['\u091B\u094C', 1],
  ['\u0907\u091B\u094C', 1, 1],
  ['\u090F\u091B\u094C', 1, 2],
  ['\u093F\u091B\u094C', 1, 3],
  ['\u0947\u091B\u094C', 1, 4],
  ['\u0928\u0947\u091B\u094C', 1, 1],
  ['\u092F\u094C', 1],
  ['\u0925\u093F\u092F\u094C', 1, 1],
  ['\u091B\u094D\u092F\u094C', 1, 2],
  ['\u0925\u094D\u092F\u094C', 1, 3],
  ['\u091B\u0928\u094D', 1],
  ['\u0907\u091B\u0928\u094D', 1, 1],
  ['\u090F\u091B\u0928\u094D', 1, 2],
  ['\u093F\u091B\u0928\u094D', 1, 3],
  ['\u0947\u091B\u0928\u094D', 1, 4],
  ['\u0928\u0947\u091B\u0928\u094D', 1, 1],
  ['\u0932\u093E\u0928\u094D', 1],
  ['\u091B\u093F\u0928\u094D', 1],
  ['\u0925\u093F\u0928\u094D', 1],
  ['\u092A\u0930\u094D', 1],
  ['\u0907\u0938\u094D', 1],
  ['\u0925\u093F\u0907\u0938\u094D', 1, 1],
  ['\u091B\u0938\u094D', 1],
  ['\u0907\u091B\u0938\u094D', 1, 1],
  ['\u090F\u091B\u0938\u094D', 1, 2],
  ['\u093F\u091B\u0938\u094D', 1, 3],
  ['\u0947\u091B\u0938\u094D', 1, 4],
  ['\u0928\u0947\u091B\u0938\u094D', 1, 1],
  ['\u093F\u0938\u094D', 1],
  ['\u0925\u093F\u0938\u094D', 1, 1],
  ['\u091B\u0947\u0938\u094D', 1],
  ['\u0939\u094B\u0938\u094D', 1],
]

export class NepaliStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    this.limit_backward = this.c
    this.c = this.limit
    const v_1: number = this.limit - this.c
    lab0: {
      this.ket = this.c
      a = this.find_among_b(a_0)
      if (a === 0) break lab0
      this.bra = this.c
      switch (a) {
        case 1: {
          this.slice_del()
          break
        }
        case 2: {
          lab1: {
            lab2: {
              if (!this.eq_s_b('\u090F')) break lab2
              break lab1
            }
            lab3: {
              if (!this.eq_s_b('\u0947')) break lab3
              break lab1
            }
            this.slice_del()
          }
          break
        }
      }
    }
    this.c = this.limit - v_1
    while (true) {
      const v_2: number = this.limit - this.c
      lab4: {
        const v_3: number = this.limit - this.c
        lab5: {
          this.ket = this.c
          a = this.find_among_b(a_1)
          if (a === 0) break lab5
          this.bra = this.c
          switch (a) {
            case 1: {
              lab6: {
                lab7: {
                  if (!this.eq_s_b('\u092F\u094C')) break lab7
                  break lab6
                }
                lab8: {
                  if (!this.eq_s_b('\u091B\u094C')) break lab8
                  break lab6
                }
                lab9: {
                  if (!this.eq_s_b('\u0928\u094C')) break lab9
                  break lab6
                }
                if (!this.eq_s_b('\u0925\u0947')) break lab5
              }
              this.slice_del()
              break
            }
            case 2: {
              if (!this.eq_s_b('\u0924\u094D\u0930')) break lab5
              this.slice_del()
              break
            }
          }
        }
        this.c = this.limit - v_3
        this.ket = this.c
        if (this.find_among_b(a_2) === 0) break lab4
        this.bra = this.c
        this.slice_del()
        continue
      }
      this.c = this.limit - v_2
      break
    }
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new NepaliStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '12453388370b3da0'
