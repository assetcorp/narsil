/*
 * Runtime for the stemmers generated from Snowball.
 *
 * Ported from javascript/base-stemmer.js in https://github.com/snowballstem/snowball,
 * BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and (c) 2002, Richard Boulton.
 *
 * The method and field names below are fixed by the Snowball code generator and are
 * spelled exactly as the generated stemmers call them.
 */

export type Among =
  | readonly [string, number]
  | readonly [string, number, number]
  | readonly [string, number, number, number]

export class BaseStemmer {
  protected current = ''
  protected c = 0
  protected limit = 0
  protected limit_backward = 0
  protected bra = 0
  protected ket = 0
  protected af = 0

  setCurrent(value: string): void {
    this.current = value
    this.c = 0
    this.limit = this.current.length
    this.limit_backward = 0
    this.bra = 0
    this.ket = 0
  }

  getCurrent(): string {
    return this.current
  }

  protected in_grouping(s: number[], min: number, max: number): boolean {
    if (this.c >= this.limit) return false
    let ch = this.current.charCodeAt(this.c)
    if (ch > max || ch < min) return false
    ch -= min
    if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) === 0) return false
    this.c++
    return true
  }

  protected go_in_grouping(s: number[], min: number, max: number): boolean {
    while (this.c < this.limit) {
      let ch = this.current.charCodeAt(this.c)
      if (ch > max || ch < min) return true
      ch -= min
      if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) === 0) return true
      this.c++
    }
    return false
  }

  protected in_grouping_b(s: number[], min: number, max: number): boolean {
    if (this.c <= this.limit_backward) return false
    let ch = this.current.charCodeAt(this.c - 1)
    if (ch > max || ch < min) return false
    ch -= min
    if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) === 0) return false
    this.c--
    return true
  }

  protected go_in_grouping_b(s: number[], min: number, max: number): boolean {
    while (this.c > this.limit_backward) {
      let ch = this.current.charCodeAt(this.c - 1)
      if (ch > max || ch < min) return true
      ch -= min
      if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) === 0) return true
      this.c--
    }
    return false
  }

  protected out_grouping(s: number[], min: number, max: number): boolean {
    if (this.c >= this.limit) return false
    let ch = this.current.charCodeAt(this.c)
    if (ch > max || ch < min) {
      this.c++
      return true
    }
    ch -= min
    if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) === 0) {
      this.c++
      return true
    }
    return false
  }

  protected go_out_grouping(s: number[], min: number, max: number): boolean {
    while (this.c < this.limit) {
      let ch = this.current.charCodeAt(this.c)
      if (ch <= max && ch >= min) {
        ch -= min
        if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) !== 0) return true
      }
      this.c++
    }
    return false
  }

  protected out_grouping_b(s: number[], min: number, max: number): boolean {
    if (this.c <= this.limit_backward) return false
    let ch = this.current.charCodeAt(this.c - 1)
    if (ch > max || ch < min) {
      this.c--
      return true
    }
    ch -= min
    if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) === 0) {
      this.c--
      return true
    }
    return false
  }

  protected go_out_grouping_b(s: number[], min: number, max: number): boolean {
    while (this.c > this.limit_backward) {
      let ch = this.current.charCodeAt(this.c - 1)
      if (ch <= max && ch >= min) {
        ch -= min
        if ((s[ch >>> 3] & (0x1 << (ch & 0x7))) !== 0) return true
      }
      this.c--
    }
    return false
  }

  protected eq_s(s: string): boolean {
    if (this.limit - this.c < s.length) return false
    if (!this.current.startsWith(s, this.c)) return false
    this.c += s.length
    return true
  }

  protected eq_s_b(s: string): boolean {
    if (this.c - this.limit_backward < s.length) return false
    if (!this.current.endsWith(s, this.c)) return false
    this.c -= s.length
    return true
  }

  protected find_among(v: readonly Among[], call_among_func?: () => boolean): number {
    let i = 0
    let j = v.length

    const c = this.c
    const l = this.limit

    let common_i = 0
    let common_j = 0

    let first_key_inspected = false

    while (true) {
      const k = i + ((j - i) >>> 1)
      let diff = 0
      let common = common_i < common_j ? common_i : common_j
      const s = v[k][0]
      for (let i2 = common; i2 < s.length; i2++) {
        if (c + common === l) {
          diff = -1
          break
        }
        diff = this.current.charCodeAt(c + common) - s.charCodeAt(i2)
        if (diff !== 0) break
        common++
      }
      if (diff < 0) {
        j = k
        common_j = common
      } else {
        i = k
        common_i = common
      }
      if (j - i <= 1) {
        if (i > 0) break
        if (j === i) break
        if (first_key_inspected) break
        first_key_inspected = true
      }
    }
    while (true) {
      const w = v[i]
      const len = w[0].length
      if (common_i >= len) {
        this.c = c + len
        const action = w[3]
        if (action === undefined) return w[1]
        this.af = action
        if (call_among_func?.call(this) === true) {
          this.c = c + len
          return w[1]
        }
      }
      const back = w[2]
      if (back === undefined || back === 0) return 0
      i -= back
    }
  }

  protected find_among_b(v: readonly Among[], call_among_func?: () => boolean): number {
    let i = 0
    let j = v.length

    const c = this.c
    const lb = this.limit_backward

    let common_i = 0
    let common_j = 0

    let first_key_inspected = false

    while (true) {
      const k = i + ((j - i) >> 1)
      let diff = 0
      let common = common_i < common_j ? common_i : common_j
      const s = v[k][0]
      for (let i2 = s.length - 1 - common; i2 >= 0; i2--) {
        if (c - common === lb) {
          diff = -1
          break
        }
        diff = this.current.charCodeAt(c - 1 - common) - s.charCodeAt(i2)
        if (diff !== 0) break
        common++
      }
      if (diff < 0) {
        j = k
        common_j = common
      } else {
        i = k
        common_i = common
      }
      if (j - i <= 1) {
        if (i > 0) break
        if (j === i) break
        if (first_key_inspected) break
        first_key_inspected = true
      }
    }
    while (true) {
      const w = v[i]
      const len = w[0].length
      if (common_i >= len) {
        this.c = c - len
        const action = w[3]
        if (action === undefined) return w[1]
        this.af = action
        if (call_among_func?.call(this) === true) {
          this.c = c - len
          return w[1]
        }
      }
      const back = w[2]
      if (back === undefined || back === 0) return 0
      i -= back
    }
  }

  private replace_s(c_bra: number, c_ket: number, s: string): number {
    const adjustment = s.length - (c_ket - c_bra)
    this.current = this.current.slice(0, c_bra) + s + this.current.slice(c_ket)
    this.limit += adjustment
    if (this.c >= c_ket) this.c += adjustment
    else if (this.c > c_bra) this.c = c_bra
    return adjustment
  }

  protected slice_from(s: string): void {
    this.replace_s(this.bra, this.ket, s)
    this.ket = this.bra + s.length
  }

  protected slice_del(): void {
    this.slice_from('')
  }

  protected insert(c_bra: number, c_ket: number, s: string): void {
    const adjustment = this.replace_s(c_bra, c_ket, s)
    if (c_bra <= this.bra) this.bra += adjustment
    if (c_bra <= this.ket) this.ket += adjustment
  }

  protected slice_to(): string {
    return this.current.slice(this.bra, this.ket)
  }
}
