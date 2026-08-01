/*
 * Generated from algorithms/greek.sbl by the Snowball compiler 3.1.1.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors.
 * Algorithm from https://github.com/snowballstem/snowball.git at 6772636350acfd63797e8cd24ff86c70fd2df6fc,
 * verified against https://github.com/snowballstem/snowball-data.git at a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * Regenerate with snowball/build.ts rather than editing this file. Revision 4f02e255d00e5848
 * digests the algorithm source and the compiler version, so a change to either marks
 * every stored index stale.
 */

import { type Among, BaseStemmer } from './base-stemmer'

const a_0: Among[] = [
  ['', 25],
  ['\u0386', 1, 1],
  ['\u0388', 5, 2],
  ['\u0389', 7, 3],
  ['\u038A', 9, 4],
  ['\u038C', 15, 5],
  ['\u038E', 20, 6],
  ['\u038F', 24, 7],
  ['\u0390', 7, 8],
  ['\u0391', 1, 9],
  ['\u0392', 2, 10],
  ['\u0393', 3, 11],
  ['\u0394', 4, 12],
  ['\u0395', 5, 13],
  ['\u0396', 6, 14],
  ['\u0397', 7, 15],
  ['\u0398', 8, 16],
  ['\u0399', 9, 17],
  ['\u039A', 10, 18],
  ['\u039B', 11, 19],
  ['\u039C', 12, 20],
  ['\u039D', 13, 21],
  ['\u039E', 14, 22],
  ['\u039F', 15, 23],
  ['\u03A0', 16, 24],
  ['\u03A1', 17, 25],
  ['\u03A3', 18, 26],
  ['\u03A4', 19, 27],
  ['\u03A5', 20, 28],
  ['\u03A6', 21, 29],
  ['\u03A7', 22, 30],
  ['\u03A8', 23, 31],
  ['\u03A9', 24, 32],
  ['\u03AA', 9, 33],
  ['\u03AB', 20, 34],
  ['\u03AC', 1, 35],
  ['\u03AD', 5, 36],
  ['\u03AE', 7, 37],
  ['\u03AF', 9, 38],
  ['\u03B0', 20, 39],
  ['\u03C2', 18, 40],
  ['\u03CA', 7, 41],
  ['\u03CB', 20, 42],
  ['\u03CC', 15, 43],
  ['\u03CD', 20, 44],
  ['\u03CE', 24, 45],
]

const a_1: Among[] = [
  ['\u03C3\u03BA\u03B1\u03B3\u03B9\u03B1', 2],
  ['\u03C6\u03B1\u03B3\u03B9\u03B1', 1],
  ['\u03BF\u03BB\u03BF\u03B3\u03B9\u03B1', 3],
  ['\u03C3\u03BF\u03B3\u03B9\u03B1', 4],
  ['\u03C4\u03B1\u03C4\u03BF\u03B3\u03B9\u03B1', 5],
  ['\u03BA\u03C1\u03B5\u03B1\u03C4\u03B1', 6],
  ['\u03C0\u03B5\u03C1\u03B1\u03C4\u03B1', 7],
  ['\u03C4\u03B5\u03C1\u03B1\u03C4\u03B1', 8],
  ['\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C4\u03B1', 11],
  ['\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C4\u03B1', 10],
  ['\u03C6\u03C9\u03C4\u03B1', 9],
  ['\u03C0\u03B5\u03C1\u03B1\u03C4\u03B7', 7],
  ['\u03C3\u03BA\u03B1\u03B3\u03B9\u03C9\u03BD', 2],
  ['\u03C6\u03B1\u03B3\u03B9\u03C9\u03BD', 1],
  ['\u03BF\u03BB\u03BF\u03B3\u03B9\u03C9\u03BD', 3],
  ['\u03C3\u03BF\u03B3\u03B9\u03C9\u03BD', 4],
  ['\u03C4\u03B1\u03C4\u03BF\u03B3\u03B9\u03C9\u03BD', 5],
  ['\u03BA\u03C1\u03B5\u03B1\u03C4\u03C9\u03BD', 6],
  ['\u03C0\u03B5\u03C1\u03B1\u03C4\u03C9\u03BD', 7],
  ['\u03C4\u03B5\u03C1\u03B1\u03C4\u03C9\u03BD', 8],
  ['\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C4\u03C9\u03BD', 11],
  ['\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C4\u03C9\u03BD', 10],
  ['\u03C6\u03C9\u03C4\u03C9\u03BD', 9],
  ['\u03BA\u03C1\u03B5\u03B1\u03C3', 6],
  ['\u03C0\u03B5\u03C1\u03B1\u03C3', 7],
  ['\u03C4\u03B5\u03C1\u03B1\u03C3', 8],
  ['\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C3', 11],
  ['\u03BA\u03C1\u03B5\u03B1\u03C4\u03BF\u03C3', 6],
  ['\u03C0\u03B5\u03C1\u03B1\u03C4\u03BF\u03C3', 7],
  ['\u03C4\u03B5\u03C1\u03B1\u03C4\u03BF\u03C3', 8],
  ['\u03B3\u03B5\u03B3\u03BF\u03BD\u03BF\u03C4\u03BF\u03C3', 11],
  ['\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C4\u03BF\u03C3', 10],
  ['\u03C6\u03C9\u03C4\u03BF\u03C3', 9],
  ['\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4\u03C9\u03C3', 10],
  ['\u03C6\u03C9\u03C3', 9],
  ['\u03C3\u03BA\u03B1\u03B3\u03B9\u03BF\u03C5', 2],
  ['\u03C6\u03B1\u03B3\u03B9\u03BF\u03C5', 1],
  ['\u03BF\u03BB\u03BF\u03B3\u03B9\u03BF\u03C5', 3],
  ['\u03C3\u03BF\u03B3\u03B9\u03BF\u03C5', 4],
  ['\u03C4\u03B1\u03C4\u03BF\u03B3\u03B9\u03BF\u03C5', 5],
]

const as_1: string[] = [
  '\u03C6\u03B1',
  '\u03C3\u03BA\u03B1',
  '\u03BF\u03BB\u03BF',
  '\u03C3\u03BF',
  '\u03C4\u03B1\u03C4\u03BF',
  '\u03BA\u03C1\u03B5',
  '\u03C0\u03B5\u03C1',
  '\u03C4\u03B5\u03C1',
  '\u03C6\u03C9',
  '\u03BA\u03B1\u03B8\u03B5\u03C3\u03C4',
  '\u03B3\u03B5\u03B3\u03BF\u03BD',
]

const a_2: Among[] = [
  ['\u03C0\u03B1', 1],
  ['\u03BE\u03B1\u03BD\u03B1\u03C0\u03B1', 1, 1],
  ['\u03B5\u03C0\u03B1', 1, 2],
  ['\u03C0\u03B5\u03C1\u03B9\u03C0\u03B1', 1, 3],
  ['\u03B1\u03BD\u03B1\u03BC\u03C0\u03B1', 1, 4],
  ['\u03B5\u03BC\u03C0\u03B1', 1, 5],
  ['\u03B2', 2],
  ['\u03B4\u03B1\u03BD\u03B5', 1],
  ['\u03B2\u03B1\u03B8\u03C5\u03C1\u03B9', 2],
  ['\u03B2\u03B1\u03C1\u03BA', 2],
  ['\u03BC\u03B1\u03C1\u03BA', 2],
  ['\u03BB', 2],
  ['\u03BC', 2],
  ['\u03BA\u03BF\u03C1\u03BD', 2],
  ['\u03B1\u03B8\u03C1\u03BF', 1],
  ['\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF', 1, 1],
  ['\u03C0', 2],
  ['\u03B9\u03BC\u03C0', 2, 1],
  ['\u03C1', 2],
  ['\u03BC\u03B1\u03C1', 2, 1],
  ['\u03B1\u03BC\u03C0\u03B1\u03C1', 2, 2],
  ['\u03B3\u03BA\u03C1', 2, 3],
  ['\u03B2\u03BF\u03BB\u03B2\u03BF\u03C1', 2, 4],
  ['\u03B3\u03BB\u03C5\u03BA\u03BF\u03C1', 2, 5],
  ['\u03C0\u03B9\u03C0\u03B5\u03C1\u03BF\u03C1', 2, 6],
  ['\u03C0\u03C1', 2, 7],
  ['\u03BC\u03C0\u03C1', 2, 1],
  ['\u03B1\u03C1\u03C1', 2, 9],
  ['\u03B3\u03BB\u03C5\u03BA\u03C5\u03C1', 2, 10],
  ['\u03C0\u03BF\u03BB\u03C5\u03C1', 2, 11],
  ['\u03BB\u03BF\u03C5', 2],
]

const as_2: string[] = ['\u03B9', '\u03B9\u03B6']

const a_3: Among[] = [
  ['\u03B9\u03B6\u03B1', 1],
  ['\u03B9\u03B6\u03B5', 1],
  ['\u03B9\u03B6\u03B1\u03BC\u03B5', 1],
  ['\u03B9\u03B6\u03BF\u03C5\u03BC\u03B5', 1],
  ['\u03B9\u03B6\u03B1\u03BD\u03B5', 1],
  ['\u03B9\u03B6\u03BF\u03C5\u03BD\u03B5', 1],
  ['\u03B9\u03B6\u03B1\u03C4\u03B5', 1],
  ['\u03B9\u03B6\u03B5\u03C4\u03B5', 1],
  ['\u03B9\u03B6\u03B5\u03B9', 1],
  ['\u03B9\u03B6\u03B1\u03BD', 1],
  ['\u03B9\u03B6\u03BF\u03C5\u03BD', 1],
  ['\u03B9\u03B6\u03B5\u03C3', 1],
  ['\u03B9\u03B6\u03B5\u03B9\u03C3', 1],
  ['\u03B9\u03B6\u03C9', 1],
]

const a_4: Among[] = [
  ['\u03B2\u03B9', 1],
  ['\u03BB\u03B9', 1],
  ['\u03B1\u03BB', 1],
  ['\u03B5\u03BD', 1],
  ['\u03C3', 1],
  ['\u03C7', 1],
  ['\u03C5\u03C8', 1],
  ['\u03B6\u03C9', 1],
]

const a_5: Among[] = [
  ['\u03C9\u03B8\u03B7\u03BA\u03B1', 1],
  ['\u03C9\u03B8\u03B7\u03BA\u03B5', 1],
  ['\u03C9\u03B8\u03B7\u03BA\u03B1\u03BC\u03B5', 1],
  ['\u03C9\u03B8\u03B7\u03BA\u03B1\u03BD\u03B5', 1],
  ['\u03C9\u03B8\u03B7\u03BA\u03B1\u03C4\u03B5', 1],
  ['\u03C9\u03B8\u03B7\u03BA\u03B1\u03BD', 1],
  ['\u03C9\u03B8\u03B7\u03BA\u03B5\u03C3', 1],
]

const a_6: Among[] = [
  ['\u03BE\u03B1\u03BD\u03B1\u03C0\u03B1', 1],
  ['\u03B5\u03C0\u03B1', 1],
  ['\u03C0\u03B5\u03C1\u03B9\u03C0\u03B1', 1],
  ['\u03B1\u03BD\u03B1\u03BC\u03C0\u03B1', 1],
  ['\u03B5\u03BC\u03C0\u03B1', 1],
  ['\u03C7\u03B1\u03C1\u03C4\u03BF\u03C0\u03B1', 1],
  ['\u03B5\u03BE\u03B1\u03C1\u03C7\u03B1', 1],
  ['\u03B3\u03B5', 2],
  ['\u03B3\u03BA\u03B5', 2],
  ['\u03BA\u03BB\u03B5', 1],
  ['\u03B5\u03BA\u03BB\u03B5', 1, 1],
  ['\u03B1\u03C0\u03B5\u03BA\u03BB\u03B5', 1, 1],
  ['\u03B1\u03C0\u03BF\u03BA\u03BB\u03B5', 1, 3],
  ['\u03B5\u03C3\u03C9\u03BA\u03BB\u03B5', 1, 4],
  ['\u03B4\u03B1\u03BD\u03B5', 1],
  ['\u03C0\u03B5', 1],
  ['\u03B5\u03C0\u03B5', 1, 1],
  ['\u03BC\u03B5\u03C4\u03B5\u03C0\u03B5', 1, 1],
  ['\u03B5\u03C3\u03B5', 1],
  ['\u03B3\u03BA', 2],
  ['\u03BC', 2],
  ['\u03C0\u03BF\u03C5\u03BA\u03B1\u03BC', 2, 1],
  ['\u03BA\u03BF\u03BC', 2, 2],
  ['\u03B1\u03BD', 2],
  ['\u03BF\u03BB\u03BF', 2],
  ['\u03B1\u03B8\u03C1\u03BF', 1],
  ['\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF', 1, 1],
  ['\u03C0', 2],
  ['\u03BB\u03B1\u03C1', 2],
  ['\u03B4\u03B7\u03BC\u03BF\u03BA\u03C1\u03B1\u03C4', 2],
  ['\u03B1\u03C6', 2],
  ['\u03B3\u03B9\u03B3\u03B1\u03BD\u03C4\u03BF\u03B1\u03C6', 2, 1],
]

const as_6: string[] = ['\u03B9', '\u03B9\u03C3']

const a_7: Among[] = [
  ['\u03B9\u03C3\u03B1', 1],
  ['\u03B9\u03C3\u03B1\u03BC\u03B5', 1],
  ['\u03B9\u03C3\u03B1\u03BD\u03B5', 1],
  ['\u03B9\u03C3\u03B5', 1],
  ['\u03B9\u03C3\u03B1\u03C4\u03B5', 1],
  ['\u03B9\u03C3\u03B1\u03BD', 1],
  ['\u03B9\u03C3\u03B5\u03C3', 1],
]

const a_8: Among[] = [
  ['\u03BE\u03B1\u03BD\u03B1\u03C0\u03B1', 1],
  ['\u03B5\u03C0\u03B1', 1],
  ['\u03C0\u03B5\u03C1\u03B9\u03C0\u03B1', 1],
  ['\u03B1\u03BD\u03B1\u03BC\u03C0\u03B1', 1],
  ['\u03B5\u03BC\u03C0\u03B1', 1],
  ['\u03C7\u03B1\u03C1\u03C4\u03BF\u03C0\u03B1', 1],
  ['\u03B5\u03BE\u03B1\u03C1\u03C7\u03B1', 1],
  ['\u03BA\u03BB\u03B5', 1],
  ['\u03B5\u03BA\u03BB\u03B5', 1, 1],
  ['\u03B1\u03C0\u03B5\u03BA\u03BB\u03B5', 1, 1],
  ['\u03B1\u03C0\u03BF\u03BA\u03BB\u03B5', 1, 3],
  ['\u03B5\u03C3\u03C9\u03BA\u03BB\u03B5', 1, 4],
  ['\u03B4\u03B1\u03BD\u03B5', 1],
  ['\u03C0\u03B5', 1],
  ['\u03B5\u03C0\u03B5', 1, 1],
  ['\u03BC\u03B5\u03C4\u03B5\u03C0\u03B5', 1, 1],
  ['\u03B5\u03C3\u03B5', 1],
  ['\u03B1\u03B8\u03C1\u03BF', 1],
  ['\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF', 1, 1],
]

const a_9: Among[] = [
  ['\u03B9\u03C3\u03BF\u03C5\u03BC\u03B5', 1],
  ['\u03B9\u03C3\u03BF\u03C5\u03BD\u03B5', 1],
  ['\u03B9\u03C3\u03B5\u03C4\u03B5', 1],
  ['\u03B9\u03C3\u03B5\u03B9', 1],
  ['\u03B9\u03C3\u03BF\u03C5\u03BD', 1],
  ['\u03B9\u03C3\u03B5\u03B9\u03C3', 1],
  ['\u03B9\u03C3\u03C9', 1],
]

const a_10: Among[] = [
  ['\u03B1\u03C4\u03B1', 2],
  ['\u03C6\u03B1', 2],
  ['\u03B7\u03C6\u03B1', 2, 1],
  ['\u03BC\u03B5\u03B3', 2],
  ['\u03BB\u03C5\u03B3', 2],
  ['\u03B7\u03B4', 2],
  ['\u03BA\u03BB\u03B5', 1],
  ['\u03B5\u03C3\u03C9\u03BA\u03BB\u03B5', 1, 1],
  ['\u03C0\u03BB\u03B5', 1],
  ['\u03B4\u03B1\u03BD\u03B5', 1],
  ['\u03C3\u03B5', 1],
  ['\u03B1\u03C3\u03B5', 1, 1],
  ['\u03BA\u03B1\u03B8', 2],
  ['\u03B5\u03C7\u03B8', 2],
  ['\u03BA\u03B1\u03BA', 2],
  ['\u03BC\u03B1\u03BA', 2],
  ['\u03C3\u03BA', 2],
  ['\u03C6\u03B9\u03BB', 2],
  ['\u03BA\u03C5\u03BB', 2],
  ['\u03BC', 2],
  ['\u03B3\u03B5\u03BC', 2, 1],
  ['\u03B1\u03C7\u03BD', 2],
  ['\u03C3\u03C5\u03BD\u03B1\u03B8\u03C1\u03BF', 1],
  ['\u03C0', 2],
  ['\u03B1\u03C0', 2, 1],
  ['\u03B5\u03BC\u03C0', 2, 2],
  ['\u03B5\u03C5\u03C0', 2, 3],
  ['\u03B1\u03C1', 2],
  ['\u03B1\u03BF\u03C1', 2],
  ['\u03B3\u03C5\u03C1', 2],
  ['\u03C7\u03C1', 2],
  ['\u03C7\u03C9\u03C1', 2],
  ['\u03BA\u03C4', 2],
  ['\u03B1\u03BA\u03C4', 2, 1],
  ['\u03C7\u03C4', 2],
  ['\u03B1\u03C7\u03C4', 2, 1],
  ['\u03C4\u03B1\u03C7', 2],
  ['\u03C3\u03C7', 2],
  ['\u03B1\u03C3\u03C7', 2, 1],
  ['\u03C5\u03C8', 2],
]

const as_10: string[] = ['\u03B9', '\u03B9\u03C3\u03C4']

const a_11: Among[] = [
  ['\u03B9\u03C3\u03C4\u03B1', 1],
  ['\u03B9\u03C3\u03C4\u03B5', 1],
  ['\u03B9\u03C3\u03C4\u03B7', 1],
  ['\u03B9\u03C3\u03C4\u03BF\u03B9', 1],
  ['\u03B9\u03C3\u03C4\u03C9\u03BD', 1],
  ['\u03B9\u03C3\u03C4\u03BF', 1],
  ['\u03B9\u03C3\u03C4\u03B5\u03C3', 1],
  ['\u03B9\u03C3\u03C4\u03B7\u03C3', 1],
  ['\u03B9\u03C3\u03C4\u03BF\u03C3', 1],
  ['\u03B9\u03C3\u03C4\u03BF\u03C5\u03C3', 1],
  ['\u03B9\u03C3\u03C4\u03BF\u03C5', 1],
]

const a_12: Among[] = [
  ['\u03B5\u03B3\u03BA\u03BB\u03B5', 1],
  ['\u03B1\u03C0\u03BF\u03BA\u03BB\u03B5', 1],
  ['\u03B4\u03B1\u03BD\u03B5', 2],
  ['\u03B1\u03BD\u03C4\u03B9\u03B4\u03B1\u03BD\u03B5', 2, 1],
  ['\u03C3\u03B5', 1],
  ['\u03BC\u03B5\u03C4\u03B1\u03C3\u03B5', 1, 1],
  ['\u03BC\u03B9\u03BA\u03C1\u03BF\u03C3\u03B5', 1, 2],
]

const as_12: string[] = ['\u03B9\u03C3\u03BC', '\u03B9']

const a_13: Among[] = [
  ['\u03B1\u03C4\u03BF\u03BC\u03B9\u03BA', 2],
  ['\u03B5\u03B8\u03BD\u03B9\u03BA', 4],
  ['\u03C4\u03BF\u03C0\u03B9\u03BA', 7],
  ['\u03B5\u03BA\u03BB\u03B5\u03BA\u03C4\u03B9\u03BA', 5],
  ['\u03C3\u03BA\u03B5\u03C0\u03C4\u03B9\u03BA', 6],
  ['\u03B3\u03BD\u03C9\u03C3\u03C4\u03B9\u03BA', 3],
  ['\u03B1\u03B3\u03BD\u03C9\u03C3\u03C4\u03B9\u03BA', 1, 1],
  ['\u03B1\u03BB\u03B5\u03BE\u03B1\u03BD\u03B4\u03C1\u03B9\u03BD', 8],
  ['\u03B8\u03B5\u03B1\u03C4\u03C1\u03B9\u03BD', 10],
  ['\u03B2\u03C5\u03B6\u03B1\u03BD\u03C4\u03B9\u03BD', 9],
]

const as_13: string[] = [
  '\u03B1\u03B3\u03BD\u03C9\u03C3\u03C4',
  '\u03B1\u03C4\u03BF\u03BC',
  '\u03B3\u03BD\u03C9\u03C3\u03C4',
  '\u03B5\u03B8\u03BD',
  '\u03B5\u03BA\u03BB\u03B5\u03BA\u03C4',
  '\u03C3\u03BA\u03B5\u03C0\u03C4',
  '\u03C4\u03BF\u03C0',
  '\u03B1\u03BB\u03B5\u03BE\u03B1\u03BD\u03B4\u03C1',
  '\u03B2\u03C5\u03B6\u03B1\u03BD\u03C4',
  '\u03B8\u03B5\u03B1\u03C4\u03C1',
]

const a_14: Among[] = [
  ['\u03B9\u03C3\u03BC\u03BF\u03B9', 1],
  ['\u03B9\u03C3\u03BC\u03C9\u03BD', 1],
  ['\u03B9\u03C3\u03BC\u03BF', 1],
  ['\u03B9\u03C3\u03BC\u03BF\u03C3', 1],
  ['\u03B9\u03C3\u03BC\u03BF\u03C5\u03C3', 1],
  ['\u03B9\u03C3\u03BC\u03BF\u03C5', 1],
]

const a_15: Among[] = [
  ['\u03C3', 1],
  ['\u03C7', 1],
]

const a_16: Among[] = [
  ['\u03BF\u03C5\u03B4\u03B1\u03BA\u03B9\u03B1', 1],
  ['\u03B1\u03C1\u03B1\u03BA\u03B9\u03B1', 1],
  ['\u03BF\u03C5\u03B4\u03B1\u03BA\u03B9', 1],
  ['\u03B1\u03C1\u03B1\u03BA\u03B9', 1],
]

const a_17: Among[] = [
  ['\u03B2', 2],
  ['\u03B2\u03B1\u03BC\u03B2', 1, 1],
  ['\u03C3\u03BB\u03BF\u03B2', 1, 2],
  ['\u03C4\u03C3\u03B5\u03C7\u03BF\u03C3\u03BB\u03BF\u03B2', 1, 1],
  ['\u03BA\u03B1\u03C1\u03B4', 2],
  ['\u03B6', 2],
  ['\u03C4\u03B6', 1, 1],
  ['\u03BA', 1],
  ['\u03BA\u03B1\u03C0\u03B1\u03BA', 1, 1],
  ['\u03C3\u03BF\u03BA', 1, 2],
  ['\u03C3\u03BA', 1, 3],
  ['\u03B2\u03B1\u03BB', 2],
  ['\u03BC\u03B1\u03BB', 1],
  ['\u03B3\u03BB', 2],
  ['\u03C4\u03C1\u03B9\u03C0\u03BF\u03BB', 2],
  ['\u03C0\u03BB', 1],
  ['\u03BB\u03BF\u03C5\u03BB', 1],
  ['\u03C6\u03C5\u03BB', 1],
  ['\u03BA\u03B1\u03B9\u03BC', 1],
  ['\u03BA\u03BB\u03B9\u03BC', 1],
  ['\u03C6\u03B1\u03C1\u03BC', 1],
  ['\u03B3\u03B9\u03B1\u03BD', 2],
  ['\u03C3\u03C0\u03B1\u03BD', 1],
  ['\u03B7\u03B3\u03BF\u03C5\u03BC\u03B5\u03BD', 2],
  ['\u03BA\u03BF\u03BD', 1],
  ['\u03BC\u03B1\u03BA\u03C1\u03C5\u03BD', 2],
  ['\u03C0', 2],
  ['\u03BA\u03B1\u03C4\u03C1\u03B1\u03C0', 1, 1],
  ['\u03C1', 1],
  ['\u03B2\u03C1', 1, 1],
  ['\u03BB\u03B1\u03B2\u03C1', 1, 1],
  ['\u03B1\u03BC\u03B2\u03C1', 1, 2],
  ['\u03BC\u03B5\u03C1', 1, 4],
  ['\u03C0\u03B1\u03C4\u03B5\u03C1', 2, 5],
  ['\u03B1\u03BD\u03B8\u03C1', 1, 6],
  ['\u03BA\u03BF\u03C1', 1, 7],
  ['\u03C3', 1],
  ['\u03BD\u03B1\u03B3\u03BA\u03B1\u03C3', 1, 1],
  ['\u03C4\u03BF\u03C3', 2, 2],
  ['\u03BC\u03BF\u03C5\u03C3\u03C4', 1],
  ['\u03C1\u03C5', 1],
  ['\u03C6', 1],
  ['\u03C3\u03C6', 1, 1],
  ['\u03B1\u03BB\u03B9\u03C3\u03C6', 1, 1],
  ['\u03BD\u03C5\u03C6', 2, 3],
  ['\u03C7', 1],
]

const as_17: string[] = ['\u03B1\u03BA', '\u03B9\u03C4\u03C3']

const a_18: Among[] = [
  ['\u03B1\u03BA\u03B9\u03B1', 1],
  ['\u03B1\u03C1\u03B1\u03BA\u03B9\u03B1', 1, 1],
  ['\u03B9\u03C4\u03C3\u03B1', 1],
  ['\u03B1\u03BA\u03B9', 1],
  ['\u03B1\u03C1\u03B1\u03BA\u03B9', 1, 1],
  ['\u03B9\u03C4\u03C3\u03C9\u03BD', 1],
  ['\u03B9\u03C4\u03C3\u03B1\u03C3', 1],
  ['\u03B9\u03C4\u03C3\u03B5\u03C3', 1],
]

const a_19: Among[] = [
  ['\u03C8\u03B1\u03BB', 1],
  ['\u03B1\u03B9\u03C6\u03BD', 1],
  ['\u03BF\u03BB\u03BF', 1],
  ['\u03B9\u03C1', 1],
]

const a_20: Among[] = [
  ['\u03B5', 1],
  ['\u03C0\u03B1\u03B9\u03C7\u03BD', 1],
]

const a_21: Among[] = [
  ['\u03B9\u03B4\u03B9\u03B1', 1],
  ['\u03B9\u03B4\u03B9\u03C9\u03BD', 1],
  ['\u03B9\u03B4\u03B9\u03BF', 1],
]

const a_22: Among[] = [
  ['\u03B9\u03B2', 1],
  ['\u03B4', 1],
  ['\u03C6\u03C1\u03B1\u03B3\u03BA', 1],
  ['\u03BB\u03C5\u03BA', 1],
  ['\u03BF\u03B2\u03B5\u03BB', 1],
  ['\u03BC\u03B7\u03BD', 1],
  ['\u03C1', 1],
]

const a_23: Among[] = [
  ['\u03B9\u03C3\u03BA\u03B5', 1],
  ['\u03B9\u03C3\u03BA\u03BF', 1],
  ['\u03B9\u03C3\u03BA\u03BF\u03C3', 1],
  ['\u03B9\u03C3\u03BA\u03BF\u03C5', 1],
]

const a_24: Among[] = [
  ['\u03B1\u03B4\u03C9\u03BD', 1],
  ['\u03B1\u03B4\u03B5\u03C3', 1],
]

const a_25: Among[] = [
  ['\u03B3\u03B9\u03B1\u03B3\u03B9', -1],
  ['\u03B8\u03B5\u03B9', -1],
  ['\u03BF\u03BA', -1],
  ['\u03BC\u03B1\u03BC', -1],
  ['\u03BC\u03B1\u03BD', -1],
  ['\u03BC\u03C0\u03B1\u03BC\u03C0', -1],
  ['\u03C0\u03B5\u03B8\u03B5\u03C1', -1],
  ['\u03C0\u03B1\u03C4\u03B5\u03C1', -1],
  ['\u03BA\u03C5\u03C1', -1],
  ['\u03BD\u03C4\u03B1\u03BD\u03C4', -1],
]

const a_26: Among[] = [
  ['\u03B5\u03B4\u03C9\u03BD', 1],
  ['\u03B5\u03B4\u03B5\u03C3', 1],
]

const a_27: Among[] = [
  ['\u03BC\u03B9\u03BB', 1],
  ['\u03B4\u03B1\u03C0', 1],
  ['\u03B3\u03B7\u03C0', 1],
  ['\u03B9\u03C0', 1],
  ['\u03B5\u03BC\u03C0', 1],
  ['\u03BF\u03C0', 1],
  ['\u03BA\u03C1\u03B1\u03C3\u03C0', 1],
  ['\u03C5\u03C0', 1],
]

const a_28: Among[] = [
  ['\u03BF\u03C5\u03B4\u03C9\u03BD', 1],
  ['\u03BF\u03C5\u03B4\u03B5\u03C3', 1],
]

const a_29: Among[] = [
  ['\u03C4\u03C1\u03B1\u03B3', 1],
  ['\u03C6\u03B5', 1],
  ['\u03BA\u03B1\u03BB\u03B9\u03B1\u03BA', 1],
  ['\u03B1\u03C1\u03BA', 1],
  ['\u03C3\u03BA', 1],
  ['\u03C0\u03B5\u03C4\u03B1\u03BB', 1],
  ['\u03B2\u03B5\u03BB', 1],
  ['\u03BB\u03BF\u03C5\u03BB', 1],
  ['\u03C6\u03BB', 1],
  ['\u03C7\u03BD', 1],
  ['\u03C0\u03BB\u03B5\u03BE', 1],
  ['\u03C3\u03C0', 1],
  ['\u03C6\u03C1', 1],
  ['\u03C3', 1],
  ['\u03BB\u03B9\u03C7', 1],
]

const a_30: Among[] = [
  ['\u03B5\u03C9\u03BD', 1],
  ['\u03B5\u03C9\u03C3', 1],
]

const a_31: Among[] = [
  ['\u03B4', 1],
  ['\u03B9\u03B4', 1, 1],
  ['\u03B8', 1],
  ['\u03B3\u03B1\u03BB', 1],
  ['\u03B5\u03BB', 1],
  ['\u03BD', 1],
  ['\u03C0', 1],
  ['\u03C0\u03B1\u03C1', 1],
]

const a_32: Among[] = [
  ['\u03B9\u03B1', 1],
  ['\u03B9\u03C9\u03BD', 1],
  ['\u03B9\u03BF\u03C5', 1],
]

const a_33: Among[] = [
  ['\u03B9\u03BA\u03B1', 1],
  ['\u03B9\u03BA\u03C9\u03BD', 1],
  ['\u03B9\u03BA\u03BF', 1],
  ['\u03B9\u03BA\u03BF\u03C5', 1],
]

const a_34: Among[] = [
  ['\u03B1\u03B4', 1],
  ['\u03C3\u03C5\u03BD\u03B1\u03B4', 1, 1],
  ['\u03BA\u03B1\u03C4\u03B1\u03B4', 1, 2],
  ['\u03B1\u03BD\u03C4\u03B9\u03B4', 1],
  ['\u03B5\u03BD\u03B4', 1],
  ['\u03C6\u03C5\u03BB\u03BF\u03B4', 1],
  ['\u03C5\u03C0\u03BF\u03B4', 1],
  ['\u03C0\u03C1\u03C9\u03C4\u03BF\u03B4', 1],
  ['\u03B5\u03BE\u03C9\u03B4', 1],
  ['\u03B7\u03B8', 1],
  ['\u03B1\u03BD\u03B7\u03B8', 1, 1],
  ['\u03BE\u03B9\u03BA', 1],
  ['\u03B1\u03BB', 1],
  ['\u03B1\u03BC\u03BC\u03BF\u03C7\u03B1\u03BB', 1, 1],
  ['\u03C3\u03C5\u03BD\u03BF\u03BC\u03B7\u03BB', 1],
  ['\u03BC\u03C0\u03BF\u03BB', 1],
  ['\u03BC\u03BF\u03C5\u03BB', 1],
  ['\u03C4\u03C3\u03B1\u03BC', 1],
  ['\u03B2\u03C1\u03C9\u03BC', 1],
  ['\u03B1\u03BC\u03B1\u03BD', 1],
  ['\u03BC\u03C0\u03B1\u03BD', 1],
  ['\u03BA\u03B1\u03BB\u03BB\u03B9\u03BD', 1],
  ['\u03C0\u03BF\u03C3\u03C4\u03B5\u03BB\u03BD', 1],
  ['\u03C6\u03B9\u03BB\u03BF\u03BD', 1],
  ['\u03BA\u03B1\u03BB\u03C0', 1],
  ['\u03B3\u03B5\u03C1', 1],
  ['\u03C7\u03B1\u03C3', 1],
  ['\u03BC\u03C0\u03BF\u03C3', 1],
  ['\u03C0\u03BB\u03B9\u03B1\u03C4\u03C3', 1],
  ['\u03C0\u03B5\u03C4\u03C3', 1],
  ['\u03C0\u03B9\u03C4\u03C3', 1],
  ['\u03C6\u03C5\u03C3', 1],
  ['\u03BC\u03C0\u03B1\u03B3\u03B9\u03B1\u03C4', 1],
  ['\u03BD\u03B9\u03C4', 1],
  ['\u03C0\u03B9\u03BA\u03B1\u03BD\u03C4', 1],
  ['\u03C3\u03B5\u03C1\u03C4', 1],
]

const a_35: Among[] = [
  ['\u03B1\u03B3\u03B1\u03BC\u03B5', 1],
  ['\u03B7\u03BA\u03B1\u03BC\u03B5', 1],
  ['\u03B7\u03B8\u03B7\u03BA\u03B1\u03BC\u03B5', 1, 1],
  ['\u03B7\u03C3\u03B1\u03BC\u03B5', 1],
  ['\u03BF\u03C5\u03C3\u03B1\u03BC\u03B5', 1],
]

const a_36: Among[] = [
  ['\u03B2\u03BF\u03C5\u03B2', 1],
  ['\u03BE\u03B5\u03B8', 1],
  ['\u03C0\u03B5\u03B8', 1],
  ['\u03B1\u03C0\u03BF\u03B8', 1],
  ['\u03B1\u03C0\u03BF\u03BA', 1],
  ['\u03BF\u03C5\u03BB', 1],
  ['\u03B1\u03BD\u03B1\u03C0', 1],
  ['\u03C0\u03B9\u03BA\u03C1', 1],
  ['\u03C0\u03BF\u03C4', 1],
  ['\u03B1\u03C0\u03BF\u03C3\u03C4', 1],
  ['\u03C7', 1],
  ['\u03C3\u03B9\u03C7', 1, 1],
]

const a_37: Among[] = [
  ['\u03C4\u03C1', 1],
  ['\u03C4\u03C3', 1],
]

const a_38: Among[] = [
  ['\u03B1\u03B3\u03B1\u03BD\u03B5', 1],
  ['\u03B7\u03BA\u03B1\u03BD\u03B5', 1],
  ['\u03B7\u03B8\u03B7\u03BA\u03B1\u03BD\u03B5', 1, 1],
  ['\u03B7\u03C3\u03B1\u03BD\u03B5', 1],
  ['\u03BF\u03C5\u03C3\u03B1\u03BD\u03B5', 1],
  ['\u03BF\u03BD\u03C4\u03B1\u03BD\u03B5', 1],
  ['\u03B9\u03BF\u03BD\u03C4\u03B1\u03BD\u03B5', 1, 1],
  ['\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD\u03B5', 1],
  ['\u03B9\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD\u03B5', 1, 1],
  ['\u03BF\u03C4\u03B1\u03BD\u03B5', 1],
  ['\u03B9\u03BF\u03C4\u03B1\u03BD\u03B5', 1, 1],
]

const a_39: Among[] = [
  ['\u03C4\u03B1\u03B2', 1],
  ['\u03BD\u03C4\u03B1\u03B2', 1, 1],
  ['\u03C8\u03B7\u03BB\u03BF\u03C4\u03B1\u03B2', 1, 2],
  ['\u03BB\u03B9\u03B2', 1],
  ['\u03BA\u03BB\u03B9\u03B2', 1, 1],
  ['\u03BE\u03B7\u03C1\u03BF\u03BA\u03BB\u03B9\u03B2', 1, 1],
  ['\u03B3', 1],
  ['\u03B1\u03B3', 1, 1],
  ['\u03C4\u03C1\u03B1\u03B3', 1, 1],
  ['\u03C4\u03C3\u03B1\u03B3', 1, 2],
  ['\u03B1\u03B8\u03B9\u03B3\u03B3', 1, 4],
  ['\u03C4\u03C3\u03B9\u03B3\u03B3', 1, 5],
  ['\u03B1\u03C4\u03C3\u03B9\u03B3\u03B3', 1, 1],
  ['\u03C3\u03C4\u03B5\u03B3', 1, 7],
  ['\u03B1\u03C0\u03B7\u03B3', 1, 8],
  ['\u03C3\u03B9\u03B3', 1, 9],
  ['\u03B1\u03BD\u03BF\u03C1\u03B3', 1, 10],
  ['\u03B5\u03BD\u03BF\u03C1\u03B3', 1, 11],
  ['\u03BA\u03B1\u03BB\u03C0\u03BF\u03C5\u03B6', 1],
  ['\u03B8', 1],
  ['\u03BC\u03C9\u03B1\u03BC\u03B5\u03B8', 1, 1],
  ['\u03C0\u03B9\u03B8', 1, 2],
  ['\u03B1\u03C0\u03B9\u03B8', 1, 1],
  ['\u03B4\u03B5\u03BA', 1],
  ['\u03C0\u03B5\u03BB\u03B5\u03BA', 1],
  ['\u03B9\u03BA', 1],
  ['\u03B1\u03BD\u03B9\u03BA', 1, 1],
  ['\u03B2\u03BF\u03C5\u03BB\u03BA', 1],
  ['\u03B2\u03B1\u03C3\u03BA', 1],
  ['\u03B2\u03C1\u03B1\u03C7\u03C5\u03BA', 1],
  ['\u03B3\u03B1\u03BB', 1],
  ['\u03BA\u03B1\u03C4\u03B1\u03B3\u03B1\u03BB', 1, 1],
  ['\u03BF\u03BB\u03BF\u03B3\u03B1\u03BB', 1, 2],
  ['\u03B2\u03B1\u03B8\u03C5\u03B3\u03B1\u03BB', 1, 3],
  ['\u03BC\u03B5\u03BB', 1],
  ['\u03BA\u03B1\u03C3\u03C4\u03B5\u03BB', 1],
  ['\u03C0\u03BF\u03C1\u03C4\u03BF\u03BB', 1],
  ['\u03C0\u03BB', 1],
  ['\u03B4\u03B9\u03C0\u03BB', 1, 1],
  ['\u03BB\u03B1\u03BF\u03C0\u03BB', 1, 2],
  ['\u03C8\u03C5\u03C7\u03BF\u03C0\u03BB', 1, 3],
  ['\u03BF\u03C5\u03BB', 1],
  ['\u03BC', 1],
  ['\u03BF\u03BB\u03B9\u03B3\u03BF\u03B4\u03B1\u03BC', 1, 1],
  ['\u03BC\u03BF\u03C5\u03C3\u03BF\u03C5\u03BB\u03BC', 1, 2],
  ['\u03B4\u03C1\u03B1\u03B4\u03BF\u03C5\u03BC', 1, 3],
  ['\u03B2\u03C1\u03B1\u03C7\u03BC', 1, 4],
  ['\u03BD', 1],
  ['\u03B1\u03BC\u03B5\u03C1\u03B9\u03BA\u03B1\u03BD', 1, 1],
  ['\u03C0', 1],
  ['\u03B1\u03B4\u03B1\u03C0', 1, 1],
  ['\u03C7\u03B1\u03BC\u03B7\u03BB\u03BF\u03B4\u03B1\u03C0', 1, 2],
  ['\u03C0\u03BF\u03BB\u03C5\u03B4\u03B1\u03C0', 1, 3],
  ['\u03BA\u03BF\u03C0', 1, 4],
  ['\u03C5\u03C0\u03BF\u03BA\u03BF\u03C0', 1, 1],
  ['\u03C4\u03C3\u03BF\u03C0', 1, 6],
  ['\u03C3\u03C0', 1, 7],
  ['\u03B5\u03C1', 1],
  ['\u03B3\u03B5\u03C1', 1, 1],
  ['\u03B2\u03B5\u03C4\u03B5\u03C1', 1, 2],
  ['\u03BB\u03BF\u03C5\u03B8\u03B7\u03C1', 1],
  ['\u03BA\u03BF\u03C1\u03BC\u03BF\u03C1', 1],
  ['\u03C0\u03B5\u03C1\u03B9\u03C4\u03C1', 1],
  ['\u03BF\u03C5\u03C1', 1],
  ['\u03C3', 1],
  ['\u03B2\u03B1\u03C3', 1, 1],
  ['\u03C0\u03BF\u03BB\u03B9\u03C3', 1, 2],
  ['\u03C3\u03B1\u03C1\u03B1\u03BA\u03B1\u03C4\u03C3', 1, 3],
  ['\u03B8\u03C5\u03C3', 1, 4],
  ['\u03B4\u03B9\u03B1\u03C4', 1],
  ['\u03C0\u03BB\u03B1\u03C4', 1],
  ['\u03C4\u03C3\u03B1\u03C1\u03BB\u03B1\u03C4', 1],
  ['\u03C4\u03B5\u03C4', 1],
  ['\u03C0\u03BF\u03C5\u03C1\u03B9\u03C4', 1],
  ['\u03C3\u03BF\u03C5\u03BB\u03C4', 1],
  ['\u03BC\u03B1\u03B9\u03BD\u03C4', 1],
  ['\u03B6\u03C9\u03BD\u03C4', 1],
  ['\u03BA\u03B1\u03C3\u03C4', 1],
  ['\u03C6', 1],
  ['\u03B4\u03B9\u03B1\u03C6', 1, 1],
  ['\u03C3\u03C4\u03B5\u03C6', 1, 2],
  ['\u03C6\u03C9\u03C4\u03BF\u03C3\u03C4\u03B5\u03C6', 1, 1],
  ['\u03C0\u03B5\u03C1\u03B7\u03C6', 1, 4],
  ['\u03C5\u03C0\u03B5\u03C1\u03B7\u03C6', 1, 1],
  ['\u03BA\u03BF\u03B9\u03BB\u03B1\u03C1\u03C6', 1, 6],
  ['\u03C0\u03B5\u03BD\u03C4\u03B1\u03C1\u03C6', 1, 7],
  ['\u03BF\u03C1\u03C6', 1, 8],
  ['\u03C7', 1],
  ['\u03B1\u03BC\u03B7\u03C7', 1, 1],
  ['\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7', 1, 2],
  ['\u03BC\u03B5\u03B3\u03BB\u03BF\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7', 1, 1],
  ['\u03BA\u03B1\u03C0\u03BD\u03BF\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7', 1, 2],
  ['\u03BC\u03B9\u03BA\u03C1\u03BF\u03B2\u03B9\u03BF\u03BC\u03B7\u03C7', 1, 3],
  ['\u03C0\u03BF\u03BB\u03C5\u03BC\u03B7\u03C7', 1, 6],
  ['\u03BB\u03B9\u03C7', 1, 7],
]

const a_40: Among[] = [
  ['\u03B5\u03BD\u03B4', 1],
  ['\u03C3\u03C5\u03BD\u03B4', 1],
  ['\u03BF\u03B4', 1],
  ['\u03B4\u03B9\u03B1\u03B8', 1],
  ['\u03BA\u03B1\u03B8', 1],
  ['\u03C1\u03B1\u03B8', 1],
  ['\u03C4\u03B1\u03B8', 1],
  ['\u03C4\u03B9\u03B8', 1],
  ['\u03B5\u03BA\u03B8', 1],
  ['\u03B5\u03BD\u03B8', 1],
  ['\u03C3\u03C5\u03BD\u03B8', 1],
  ['\u03C1\u03BF\u03B8', 1],
  ['\u03C5\u03C0\u03B5\u03C1\u03B8', 1],
  ['\u03C3\u03B8', 1],
  ['\u03B5\u03C5\u03B8', 1],
  ['\u03B1\u03C1\u03BA', 1],
  ['\u03C9\u03C6\u03B5\u03BB', 1],
  ['\u03B2\u03BF\u03BB', 1],
  ['\u03B1\u03B9\u03BD', 1],
  ['\u03C0\u03BF\u03BD', 1],
  ['\u03C1\u03BF\u03BD', 1],
  ['\u03C3\u03C5\u03BD', 1],
  ['\u03B2\u03B1\u03C1', 1],
  ['\u03B2\u03C1', 1],
  ['\u03B1\u03B9\u03C1', 1],
  ['\u03C6\u03BF\u03C1', 1],
  ['\u03B5\u03C5\u03C1', 1],
  ['\u03C0\u03C5\u03C1', 1],
  ['\u03C7\u03C9\u03C1', 1],
  ['\u03BD\u03B5\u03C4', 1],
  ['\u03C3\u03C7', 1],
]

const a_41: Among[] = [
  ['\u03C0\u03B1\u03B3', 1],
  ['\u03B4', 1],
  ['\u03B1\u03B4', 1, 1],
  ['\u03B8', 1],
  ['\u03B1\u03B8', 1, 1],
  ['\u03C4\u03BF\u03BA', 1],
  ['\u03C3\u03BA', 1],
  ['\u03C0\u03B1\u03C1\u03B1\u03BA\u03B1\u03BB', 1],
  ['\u03C3\u03BA\u03B5\u03BB', 1],
  ['\u03B1\u03C0\u03BB', 1],
  ['\u03B5\u03BC', 1],
  ['\u03B1\u03BD', 1],
  ['\u03B2\u03B5\u03BD', 1],
  ['\u03B2\u03B1\u03C1\u03BF\u03BD', 1],
  ['\u03BA\u03BF\u03C0', 1],
  ['\u03C3\u03B5\u03C1\u03C0', 1],
  ['\u03B1\u03B2\u03B1\u03C1', 1],
  ['\u03B5\u03BD\u03B1\u03C1', 1],
  ['\u03B1\u03B2\u03C1', 1],
  ['\u03BC\u03C0\u03BF\u03C1', 1],
  ['\u03B8\u03B1\u03C1\u03C1', 1],
  ['\u03BD\u03C4\u03C1', 1],
  ['\u03C5', 1],
  ['\u03BD\u03B9\u03C6', 1],
  ['\u03C3\u03C5\u03C1\u03C6', 1],
]

const a_42: Among[] = [
  ['\u03BF\u03BD\u03C4\u03B1\u03C3', 1],
  ['\u03C9\u03BD\u03C4\u03B1\u03C3', 1],
]

const a_43: Among[] = [
  ['\u03BF\u03BC\u03B1\u03C3\u03C4\u03B5', 1],
  ['\u03B9\u03BF\u03BC\u03B1\u03C3\u03C4\u03B5', 1, 1],
]

const a_44: Among[] = [
  ['\u03C0', 1],
  ['\u03B1\u03C0', 1, 1],
  ['\u03B1\u03BA\u03B1\u03C4\u03B1\u03C0', 1, 1],
  ['\u03C3\u03C5\u03BC\u03C0', 1, 3],
  ['\u03B1\u03C3\u03C5\u03BC\u03C0', 1, 1],
  ['\u03B1\u03BC\u03B5\u03C4\u03B1\u03BC\u03C6', 1],
]

const a_45: Among[] = [
  ['\u03B6', 1],
  ['\u03B1\u03BB', 1],
  ['\u03C0\u03B1\u03C1\u03B1\u03BA\u03B1\u03BB', 1, 1],
  ['\u03B5\u03BA\u03C4\u03B5\u03BB', 1],
  ['\u03BC', 1],
  ['\u03BE', 1],
  ['\u03C0\u03C1\u03BF', 1],
  ['\u03B1\u03C1', 1],
  ['\u03BD\u03B9\u03C3', 1],
]

const a_46: Among[] = [
  ['\u03B7\u03B8\u03B7\u03BA\u03B1', 1],
  ['\u03B7\u03B8\u03B7\u03BA\u03B5', 1],
  ['\u03B7\u03B8\u03B7\u03BA\u03B5\u03C3', 1],
]

const a_47: Among[] = [
  ['\u03C0\u03B9\u03B8', 1],
  ['\u03BF\u03B8', 1],
  ['\u03BD\u03B1\u03C1\u03B8', 1],
  ['\u03C3\u03BA\u03BF\u03C5\u03BB', 1],
  ['\u03C3\u03BA\u03C9\u03BB', 1],
  ['\u03C3\u03C6', 1],
]

const a_48: Among[] = [
  ['\u03B8', 1],
  ['\u03B4\u03B9\u03B1\u03B8', 1, 1],
  ['\u03C0\u03B1\u03C1\u03B1\u03BA\u03B1\u03C4\u03B1\u03B8', 1, 2],
  ['\u03C3\u03C5\u03BD\u03B8', 1, 3],
  ['\u03C0\u03C1\u03BF\u03C3\u03B8', 1, 4],
]

const a_49: Among[] = [
  ['\u03B7\u03BA\u03B1', 1],
  ['\u03B7\u03BA\u03B5', 1],
  ['\u03B7\u03BA\u03B5\u03C3', 1],
]

const a_50: Among[] = [
  ['\u03C6\u03B1\u03B3', 1],
  ['\u03BB\u03B7\u03B3', 1],
  ['\u03C6\u03C1\u03C5\u03B4', 1],
  ['\u03BC\u03B1\u03BD\u03C4\u03B9\u03BB', 1],
  ['\u03BC\u03B1\u03BB\u03BB', 1],
  ['\u03BF\u03BC', 1],
  ['\u03B2\u03BB\u03B5\u03C0', 1],
  ['\u03C0\u03BF\u03B4\u03B1\u03C1', 1],
  ['\u03BA\u03C5\u03BC\u03B1\u03C4', 1],
  ['\u03C0\u03C1\u03C9\u03C4', 1],
  ['\u03BB\u03B1\u03C7', 1],
  ['\u03C0\u03B1\u03BD\u03C4\u03B1\u03C7', 1],
]

const a_51: Among[] = [
  ['\u03C4\u03C3\u03B1', 1],
  ['\u03C7\u03B1\u03B4', 1],
  ['\u03BC\u03B5\u03B4', 1],
  ['\u03BB\u03B1\u03BC\u03C0\u03B9\u03B4', 1],
  ['\u03B4\u03B5', 1],
  ['\u03C0\u03BB\u03B5', 1],
  ['\u03BC\u03B5\u03C3\u03B1\u03B6', 1],
  ['\u03B4\u03B5\u03C3\u03C0\u03BF\u03B6', 1],
  ['\u03B1\u03B9\u03B8', 1],
  ['\u03C6\u03B1\u03C1\u03BC\u03B1\u03BA', 1],
  ['\u03B1\u03B3\u03BA', 1],
  ['\u03B1\u03BD\u03B7\u03BA', 1],
  ['\u03BB', 1],
  ['\u03BC', 1],
  ['\u03B1\u03BC', 1, 1],
  ['\u03B2\u03C1\u03BF\u03BC', 1, 2],
  ['\u03C5\u03C0\u03BF\u03C4\u03B5\u03B9\u03BD', 1],
  ['\u03B5\u03BA\u03BB\u03B9\u03C0', 1],
  ['\u03C1', 1],
  ['\u03B5\u03BD\u03B4\u03B9\u03B1\u03C6\u03B5\u03C1', 1, 1],
  ['\u03B1\u03BD\u03B1\u03C1\u03C1', 1, 2],
  ['\u03C0\u03B1\u03C4', 1],
  ['\u03BA\u03B1\u03B8\u03B1\u03C1\u03B5\u03C5', 1],
  ['\u03B4\u03B5\u03C5\u03C4\u03B5\u03C1\u03B5\u03C5', 1],
  ['\u03BB\u03B5\u03C7', 1],
]

const a_52: Among[] = [
  ['\u03BF\u03C5\u03C3\u03B1', 1],
  ['\u03BF\u03C5\u03C3\u03B5', 1],
  ['\u03BF\u03C5\u03C3\u03B5\u03C3', 1],
]

const a_53: Among[] = [
  ['\u03C0\u03B5\u03BB', 1],
  ['\u03BB\u03BB', 1],
  ['\u03C3\u03BC\u03B7\u03BD', 1],
  ['\u03C1\u03C0', 1],
  ['\u03C0\u03C1', 1],
  ['\u03C6\u03C1', 1],
  ['\u03C7\u03BF\u03C1\u03C4', 1],
  ['\u03BF\u03C6', 1],
  ['\u03C8\u03BF\u03C6', -1, 1],
  ['\u03C3\u03C6', 1],
  ['\u03BB\u03BF\u03C7', 1],
  ['\u03BD\u03B1\u03C5\u03BB\u03BF\u03C7', -1, 1],
]

const a_54: Among[] = [
  ['\u03B1\u03BC\u03B1\u03BB\u03BB\u03B9', 1],
  ['\u03BB', 1],
  ['\u03B1\u03BC\u03B1\u03BB', 1, 1],
  ['\u03BC', 1],
  ['\u03BF\u03C5\u03BB\u03B1\u03BC', 1, 1],
  ['\u03B5\u03BD', 1],
  ['\u03B4\u03B5\u03C1\u03B2\u03B5\u03BD', 1, 1],
  ['\u03C0', 1],
  ['\u03B1\u03B5\u03B9\u03C0', 1, 1],
  ['\u03B1\u03C1\u03C4\u03B9\u03C0', 1, 2],
  ['\u03C3\u03C5\u03BC\u03C0', 1, 3],
  ['\u03BD\u03B5\u03BF\u03C0', 1, 4],
  ['\u03BA\u03C1\u03BF\u03BA\u03B1\u03BB\u03BF\u03C0', 1, 5],
  ['\u03BF\u03BB\u03BF\u03C0', 1, 6],
  ['\u03C0\u03C1\u03BF\u03C3\u03C9\u03C0\u03BF\u03C0', 1, 7],
  ['\u03C3\u03B9\u03B4\u03B7\u03C1\u03BF\u03C0', 1, 8],
  ['\u03B4\u03C1\u03BF\u03C3\u03BF\u03C0', 1, 9],
  ['\u03B1\u03C3\u03C0', 1, 10],
  ['\u03B1\u03BD\u03C5\u03C0', 1, 11],
  ['\u03C1', 1],
  ['\u03B1\u03C3\u03C0\u03B1\u03C1', 1, 1],
  ['\u03C7\u03B1\u03C1', 1, 2],
  ['\u03B1\u03C7\u03B1\u03C1', 1, 1],
  ['\u03B1\u03C0\u03B5\u03C1', 1, 4],
  ['\u03C4\u03C1', 1, 5],
  ['\u03BF\u03C5\u03C1', 1, 6],
  ['\u03C4', 1],
  ['\u03B4\u03B9\u03B1\u03C4', 1, 1],
  ['\u03B5\u03C0\u03B9\u03C4', 1, 2],
  ['\u03C3\u03C5\u03BD\u03C4', 1, 3],
  ['\u03BF\u03BC\u03BF\u03C4', 1, 4],
  ['\u03BD\u03BF\u03BC\u03BF\u03C4', 1, 1],
  ['\u03B1\u03C0\u03BF\u03C4', 1, 6],
  ['\u03C5\u03C0\u03BF\u03C4', 1, 7],
  ['\u03B1\u03B2\u03B1\u03C3\u03C4', 1, 8],
  ['\u03B1\u03B9\u03BC\u03BF\u03C3\u03C4', 1, 9],
  ['\u03C0\u03C1\u03BF\u03C3\u03C4', 1, 10],
  ['\u03B1\u03BD\u03C5\u03C3\u03C4', 1, 11],
  ['\u03BD\u03B1\u03C5', 1],
  ['\u03B1\u03C6', 1],
  ['\u03BE\u03B5\u03C6', 1],
  ['\u03B1\u03B4\u03B7\u03C6', 1],
  ['\u03C0\u03B1\u03BC\u03C6', 1],
  ['\u03C0\u03BF\u03BB\u03C5\u03C6', 1],
]

const a_55: Among[] = [
  ['\u03B1\u03B3\u03B1', 1],
  ['\u03B1\u03B3\u03B5', 1],
  ['\u03B1\u03B3\u03B5\u03C3', 1],
]

const a_56: Among[] = [
  ['\u03B7\u03C3\u03B1', 1],
  ['\u03B7\u03C3\u03B5', 1],
  ['\u03B7\u03C3\u03BF\u03C5', 1],
]

const a_57: Among[] = [
  ['\u03BD', 1],
  ['\u03B4\u03C9\u03B4\u03B5\u03BA\u03B1\u03BD', 1, 1],
  ['\u03B5\u03C0\u03C4\u03B1\u03BD', 1, 2],
  ['\u03BC\u03B5\u03B3\u03B1\u03BB\u03BF\u03BD', 1, 3],
  ['\u03B5\u03C1\u03B7\u03BC\u03BF\u03BD', 1, 4],
  ['\u03C7\u03B5\u03C1\u03C3\u03BF\u03BD', 1, 5],
]

const a_58: Among[] = [
  ['\u03C3\u03B2', 1],
  ['\u03B1\u03C3\u03B2', 1, 1],
  ['\u03B1\u03C0\u03BB', 1],
  ['\u03B1\u03B5\u03B9\u03BC\u03BD', 1],
  ['\u03C7\u03C1', 1],
  ['\u03B1\u03C7\u03C1', 1, 1],
  ['\u03BA\u03BF\u03B9\u03BD\u03BF\u03C7\u03C1', 1, 2],
  ['\u03B4\u03C5\u03C3\u03C7\u03C1', 1, 3],
  ['\u03B5\u03C5\u03C7\u03C1', 1, 4],
  ['\u03C0\u03B1\u03BB\u03B9\u03BC\u03C8', 1],
]

const a_59: Among[] = [
  ['\u03BF\u03C5\u03BD\u03B5', 1],
  ['\u03B7\u03B8\u03BF\u03C5\u03BD\u03B5', 1, 1],
  ['\u03B7\u03C3\u03BF\u03C5\u03BD\u03B5', 1, 2],
]

const a_60: Among[] = [
  ['\u03C3\u03C0\u03B9', 1],
  ['\u03BD', 1],
  ['\u03B5\u03BE\u03C9\u03BD', 1, 1],
  ['\u03C1', 1],
  ['\u03C3\u03C4\u03C1\u03B1\u03B2\u03BF\u03BC\u03BF\u03C5\u03C4\u03C3', 1],
  ['\u03BA\u03B1\u03BA\u03BF\u03BC\u03BF\u03C5\u03C4\u03C3', 1],
]

const a_61: Among[] = [
  ['\u03BF\u03C5\u03BC\u03B5', 1],
  ['\u03B7\u03B8\u03BF\u03C5\u03BC\u03B5', 1, 1],
  ['\u03B7\u03C3\u03BF\u03C5\u03BC\u03B5', 1, 2],
]

const a_62: Among[] = [
  ['\u03B1\u03B6', 1],
  ['\u03C9\u03C1\u03B9\u03BF\u03C0\u03BB', 1],
  ['\u03B1\u03C3\u03BF\u03C5\u03C3', 1],
  ['\u03C0\u03B1\u03C1\u03B1\u03C3\u03BF\u03C5\u03C3', 1, 1],
  ['\u03B1\u03BB\u03BB\u03BF\u03C3\u03BF\u03C5\u03C3', 1],
  ['\u03C6', 1],
  ['\u03C7', 1],
]

const a_63: Among[] = [
  ['\u03BC\u03B1\u03C4\u03B1', 1],
  ['\u03BC\u03B1\u03C4\u03C9\u03BD', 1],
  ['\u03BC\u03B1\u03C4\u03BF\u03C3', 1],
]

const a_64: Among[] = [
  ['\u03B1', 1],
  ['\u03B9\u03BF\u03C5\u03BC\u03B1', 1, 1],
  ['\u03BF\u03BC\u03BF\u03C5\u03BD\u03B1', 1, 2],
  ['\u03B9\u03BF\u03BC\u03BF\u03C5\u03BD\u03B1', 1, 1],
  ['\u03BF\u03C3\u03BF\u03C5\u03BD\u03B1', 1, 4],
  ['\u03B9\u03BF\u03C3\u03BF\u03C5\u03BD\u03B1', 1, 1],
  ['\u03B5', 1],
  ['\u03B1\u03B3\u03B1\u03C4\u03B5', 1, 1],
  ['\u03B7\u03BA\u03B1\u03C4\u03B5', 1, 2],
  ['\u03B7\u03B8\u03B7\u03BA\u03B1\u03C4\u03B5', 1, 1],
  ['\u03B7\u03C3\u03B1\u03C4\u03B5', 1, 4],
  ['\u03BF\u03C5\u03C3\u03B1\u03C4\u03B5', 1, 5],
  ['\u03B5\u03B9\u03C4\u03B5', 1, 6],
  ['\u03B7\u03B8\u03B5\u03B9\u03C4\u03B5', 1, 1],
  ['\u03B9\u03B5\u03BC\u03B1\u03C3\u03C4\u03B5', 1, 8],
  ['\u03BF\u03C5\u03BC\u03B1\u03C3\u03C4\u03B5', 1, 9],
  ['\u03B9\u03BF\u03C5\u03BC\u03B1\u03C3\u03C4\u03B5', 1, 1],
  ['\u03B9\u03B5\u03C3\u03B1\u03C3\u03C4\u03B5', 1, 11],
  ['\u03BF\u03C3\u03B1\u03C3\u03C4\u03B5', 1, 12],
  ['\u03B9\u03BF\u03C3\u03B1\u03C3\u03C4\u03B5', 1, 1],
  ['\u03B7', 1],
  ['\u03B9', 1],
  ['\u03B1\u03BC\u03B1\u03B9', 1, 1],
  ['\u03B9\u03B5\u03BC\u03B1\u03B9', 1, 2],
  ['\u03BF\u03BC\u03B1\u03B9', 1, 3],
  ['\u03BF\u03C5\u03BC\u03B1\u03B9', 1, 4],
  ['\u03B1\u03C3\u03B1\u03B9', 1, 5],
  ['\u03B5\u03C3\u03B1\u03B9', 1, 6],
  ['\u03B9\u03B5\u03C3\u03B1\u03B9', 1, 1],
  ['\u03B1\u03C4\u03B1\u03B9', 1, 8],
  ['\u03B5\u03C4\u03B1\u03B9', 1, 9],
  ['\u03B9\u03B5\u03C4\u03B1\u03B9', 1, 1],
  ['\u03BF\u03BD\u03C4\u03B1\u03B9', 1, 11],
  ['\u03BF\u03C5\u03BD\u03C4\u03B1\u03B9', 1, 12],
  ['\u03B9\u03BF\u03C5\u03BD\u03C4\u03B1\u03B9', 1, 1],
  ['\u03B5\u03B9', 1, 14],
  ['\u03B1\u03B5\u03B9', 1, 1],
  ['\u03B7\u03B8\u03B5\u03B9', 1, 2],
  ['\u03B7\u03C3\u03B5\u03B9', 1, 3],
  ['\u03BF\u03B9', 1, 18],
  ['\u03B1\u03BD', 1],
  ['\u03B1\u03B3\u03B1\u03BD', 1, 1],
  ['\u03B7\u03BA\u03B1\u03BD', 1, 2],
  ['\u03B7\u03B8\u03B7\u03BA\u03B1\u03BD', 1, 1],
  ['\u03B7\u03C3\u03B1\u03BD', 1, 4],
  ['\u03BF\u03C5\u03C3\u03B1\u03BD', 1, 5],
  ['\u03BF\u03BD\u03C4\u03BF\u03C5\u03C3\u03B1\u03BD', 1, 1],
  ['\u03B9\u03BF\u03BD\u03C4\u03BF\u03C5\u03C3\u03B1\u03BD', 1, 1],
  ['\u03BF\u03BD\u03C4\u03B1\u03BD', 1, 8],
  ['\u03B9\u03BF\u03BD\u03C4\u03B1\u03BD', 1, 1],
  ['\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD', 1, 10],
  ['\u03B9\u03BF\u03C5\u03BD\u03C4\u03B1\u03BD', 1, 1],
  ['\u03BF\u03C4\u03B1\u03BD', 1, 12],
  ['\u03B9\u03BF\u03C4\u03B1\u03BD', 1, 1],
  ['\u03BF\u03BC\u03B1\u03C3\u03C4\u03B1\u03BD', 1, 14],
  ['\u03B9\u03BF\u03BC\u03B1\u03C3\u03C4\u03B1\u03BD', 1, 1],
  ['\u03BF\u03C3\u03B1\u03C3\u03C4\u03B1\u03BD', 1, 16],
  ['\u03B9\u03BF\u03C3\u03B1\u03C3\u03C4\u03B1\u03BD', 1, 1],
  ['\u03BF\u03C5\u03BD', 1],
  ['\u03B7\u03B8\u03BF\u03C5\u03BD', 1, 1],
  ['\u03BF\u03BC\u03BF\u03C5\u03BD', 1, 2],
  ['\u03B9\u03BF\u03BC\u03BF\u03C5\u03BD', 1, 1],
  ['\u03B7\u03C3\u03BF\u03C5\u03BD', 1, 4],
  ['\u03BF\u03C3\u03BF\u03C5\u03BD', 1, 5],
  ['\u03B9\u03BF\u03C3\u03BF\u03C5\u03BD', 1, 1],
  ['\u03C9\u03BD', 1],
  ['\u03B7\u03B4\u03C9\u03BD', 1, 1],
  ['\u03BF', 1],
  ['\u03B1\u03C3', 1],
  ['\u03B5\u03C3', 1],
  ['\u03B7\u03B4\u03B5\u03C3', 1, 1],
  ['\u03B7\u03C3\u03B5\u03C3', 1, 2],
  ['\u03B7\u03C3', 1],
  ['\u03B5\u03B9\u03C3', 1],
  ['\u03B7\u03B8\u03B5\u03B9\u03C3', 1, 1],
  ['\u03BF\u03C3', 1],
  ['\u03C5\u03C3', 1],
  ['\u03BF\u03C5\u03C3', 1, 1],
  ['\u03C5', 1],
  ['\u03BF\u03C5', 1, 1],
  ['\u03C9', 1],
  ['\u03B1\u03C9', 1, 1],
  ['\u03B7\u03B8\u03C9', 1, 2],
  ['\u03B7\u03C3\u03C9', 1, 3],
]

const a_65: Among[] = [
  ['\u03BF\u03C4\u03B5\u03C1', 1],
  ['\u03B5\u03C3\u03C4\u03B5\u03C1', 1],
  ['\u03C5\u03C4\u03B5\u03C1', 1],
  ['\u03C9\u03C4\u03B5\u03C1', 1],
  ['\u03BF\u03C4\u03B1\u03C4', 1],
  ['\u03B5\u03C3\u03C4\u03B1\u03C4', 1],
  ['\u03C5\u03C4\u03B1\u03C4', 1],
  ['\u03C9\u03C4\u03B1\u03C4', 1],
]

const g_v: number[] = [81, 65, 16, 1]

const g_v2: number[] = [81, 65, 0, 1]

export class GreekStemmer extends BaseStemmer {
  #stem(): boolean {
    let a: number
    let B_test1: boolean
    this.limit_backward = this.c
    this.c = this.limit
    const v_1: number = this.limit - this.c
    while (true) {
      const v_2: number = this.limit - this.c
      lab1: {
        this.ket = this.c
        a = this.find_among_b(a_0)
        this.bra = this.c
        switch (a) {
          case 1: {
            this.slice_from('\u03B1')
            break
          }
          case 2: {
            this.slice_from('\u03B2')
            break
          }
          case 3: {
            this.slice_from('\u03B3')
            break
          }
          case 4: {
            this.slice_from('\u03B4')
            break
          }
          case 5: {
            this.slice_from('\u03B5')
            break
          }
          case 6: {
            this.slice_from('\u03B6')
            break
          }
          case 7: {
            this.slice_from('\u03B7')
            break
          }
          case 8: {
            this.slice_from('\u03B8')
            break
          }
          case 9: {
            this.slice_from('\u03B9')
            break
          }
          case 10: {
            this.slice_from('\u03BA')
            break
          }
          case 11: {
            this.slice_from('\u03BB')
            break
          }
          case 12: {
            this.slice_from('\u03BC')
            break
          }
          case 13: {
            this.slice_from('\u03BD')
            break
          }
          case 14: {
            this.slice_from('\u03BE')
            break
          }
          case 15: {
            this.slice_from('\u03BF')
            break
          }
          case 16: {
            this.slice_from('\u03C0')
            break
          }
          case 17: {
            this.slice_from('\u03C1')
            break
          }
          case 18: {
            this.slice_from('\u03C3')
            break
          }
          case 19: {
            this.slice_from('\u03C4')
            break
          }
          case 20: {
            this.slice_from('\u03C5')
            break
          }
          case 21: {
            this.slice_from('\u03C6')
            break
          }
          case 22: {
            this.slice_from('\u03C7')
            break
          }
          case 23: {
            this.slice_from('\u03C8')
            break
          }
          case 24: {
            this.slice_from('\u03C9')
            break
          }
          case 25: {
            if (this.c <= this.limit_backward) break lab1
            this.c--
            break
          }
        }
        continue
      }
      this.c = this.limit - v_2
      break
    }
    this.c = this.limit - v_1
    if (/**@type {boolean}*/ (this.current.length < 3)) return false
    B_test1 = true
    const v_3: number = this.limit - this.c
    lab2: {
      this.ket = this.c
      a = this.find_among_b(a_1)
      if (a === 0) break lab2
      this.bra = this.c
      this.slice_from(as_1[a - 1])
      B_test1 = false
    }
    this.c = this.limit - v_3
    const v_4: number = this.limit - this.c
    lab3: {
      this.ket = this.c
      if (this.find_among_b(a_3) === 0) break lab3
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      a = this.find_among_b(a_2)
      if (a === 0) break lab3
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab3
      this.slice_from(as_2[a - 1])
    }
    this.c = this.limit - v_4
    const v_5: number = this.limit - this.c
    lab4: {
      this.ket = this.c
      if (this.find_among_b(a_5) === 0) break lab4
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_4) === 0) break lab4
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab4
      this.slice_from('\u03C9\u03BD')
    }
    this.c = this.limit - v_5
    const v_6: number = this.limit - this.c
    lab5: {
      lab6: {
        const v_7: number = this.limit - this.c
        lab7: {
          this.ket = this.c
          if (!this.eq_s_b('\u03B9\u03C3\u03B1')) break lab7
          this.bra = this.c
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab7
          this.slice_from('\u03B9\u03C3')
          break lab6
        }
        this.c = this.limit - v_7
        this.ket = this.c
      }
      if (this.find_among_b(a_7) === 0) break lab5
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      a = this.find_among_b(a_6)
      if (a === 0) break lab5
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab5
      this.slice_from(as_6[a - 1])
    }
    this.c = this.limit - v_6
    const v_8: number = this.limit - this.c
    lab8: {
      this.ket = this.c
      if (this.find_among_b(a_9) === 0) break lab8
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_8) === 0) break lab8
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab8
      this.slice_from('\u03B9')
    }
    this.c = this.limit - v_8
    const v_9: number = this.limit - this.c
    lab9: {
      this.ket = this.c
      if (this.find_among_b(a_11) === 0) break lab9
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      a = this.find_among_b(a_10)
      if (a === 0) break lab9
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab9
      this.slice_from(as_10[a - 1])
    }
    this.c = this.limit - v_9
    const v_10: number = this.limit - this.c
    lab10: {
      this.ket = this.c
      if (this.find_among_b(a_14) === 0) break lab10
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab11: {
        const v_11: number = this.limit - this.c
        lab12: {
          this.ket = this.c
          this.bra = this.c
          a = this.find_among_b(a_12)
          if (a === 0) break lab12
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab12
          this.slice_from(as_12[a - 1])
          break lab11
        }
        this.c = this.limit - v_11
        this.ket = this.c
        a = this.find_among_b(a_13)
        if (a === 0) break lab10
        this.bra = this.c
        this.slice_from(as_13[a - 1])
      }
    }
    this.c = this.limit - v_10
    const v_12: number = this.limit - this.c
    lab13: {
      this.ket = this.c
      if (this.find_among_b(a_16) === 0) break lab13
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_15) === 0) break lab13
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab13
      this.slice_from('\u03B1\u03C1\u03B1\u03BA')
    }
    this.c = this.limit - v_12
    const v_13: number = this.limit - this.c
    lab14: {
      this.ket = this.c
      if (this.find_among_b(a_18) === 0) break lab14
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab15: {
        const v_14: number = this.limit - this.c
        lab16: {
          this.ket = this.c
          this.bra = this.c
          a = this.find_among_b(a_17)
          if (a === 0) break lab16
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab16
          this.slice_from(as_17[a - 1])
          break lab15
        }
        this.c = this.limit - v_14
        this.ket = this.c
        this.bra = this.c
        if (!this.eq_s_b('\u03BA\u03BF\u03C1')) break lab14
        this.slice_from('\u03B9\u03C4\u03C3')
      }
    }
    this.c = this.limit - v_13
    const v_15: number = this.limit - this.c
    lab17: {
      this.ket = this.c
      if (this.find_among_b(a_21) === 0) break lab17
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab18: {
        const v_16: number = this.limit - this.c
        lab19: {
          this.ket = this.c
          this.bra = this.c
          if (this.find_among_b(a_19) === 0) break lab19
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab19
          this.slice_from('\u03B9\u03B4')
          break lab18
        }
        this.c = this.limit - v_16
        this.ket = this.c
        this.bra = this.c
        if (this.find_among_b(a_20) === 0) break lab17
        this.slice_from('\u03B9\u03B4')
      }
    }
    this.c = this.limit - v_15
    const v_17: number = this.limit - this.c
    lab20: {
      this.ket = this.c
      if (this.find_among_b(a_23) === 0) break lab20
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_22) === 0) break lab20
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab20
      this.slice_from('\u03B9\u03C3\u03BA')
    }
    this.c = this.limit - v_17
    const v_18: number = this.limit - this.c
    lab21: {
      this.ket = this.c
      if (this.find_among_b(a_24) === 0) break lab21
      this.bra = this.c
      this.slice_del()
      {
        const v_19: number = this.limit - this.c
        lab22: {
          if (this.find_among_b(a_25) === 0) break lab22
          break lab21
        }
        this.c = this.limit - v_19
      }
      {
        const c: number = this.c
        this.insert(c, c, '\u03B1\u03B4')
        this.c = c
      }
    }
    this.c = this.limit - v_18
    const v_20: number = this.limit - this.c
    lab23: {
      this.ket = this.c
      if (this.find_among_b(a_26) === 0) break lab23
      this.bra = this.c
      this.slice_del()
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_27) === 0) break lab23
      this.slice_from('\u03B5\u03B4')
    }
    this.c = this.limit - v_20
    const v_21: number = this.limit - this.c
    lab24: {
      this.ket = this.c
      if (this.find_among_b(a_28) === 0) break lab24
      this.bra = this.c
      this.slice_del()
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_29) === 0) break lab24
      this.slice_from('\u03BF\u03C5\u03B4')
    }
    this.c = this.limit - v_21
    const v_22: number = this.limit - this.c
    lab25: {
      this.ket = this.c
      if (this.find_among_b(a_30) === 0) break lab25
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_31) === 0) break lab25
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab25
      this.slice_from('\u03B5')
    }
    this.c = this.limit - v_22
    const v_23: number = this.limit - this.c
    lab26: {
      this.ket = this.c
      if (this.find_among_b(a_32) === 0) break lab26
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (!this.in_grouping_b(g_v, 945, 969)) break lab26
      this.slice_from('\u03B9')
    }
    this.c = this.limit - v_23
    const v_24: number = this.limit - this.c
    lab27: {
      this.ket = this.c
      if (this.find_among_b(a_33) === 0) break lab27
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab28: {
        const v_25: number = this.limit - this.c
        lab29: {
          this.ket = this.c
          this.bra = this.c
          if (!this.in_grouping_b(g_v, 945, 969)) break lab29
          this.slice_from('\u03B9\u03BA')
          break lab28
        }
        this.c = this.limit - v_25
        this.ket = this.c
      }
      this.bra = this.c
      if (this.find_among_b(a_34) === 0) break lab27
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab27
      this.slice_from('\u03B9\u03BA')
    }
    this.c = this.limit - v_24
    const v_26: number = this.limit - this.c
    lab30: {
      const v_27: number = this.limit - this.c
      lab31: {
        this.ket = this.c
        if (!this.eq_s_b('\u03B1\u03B3\u03B1\u03BC\u03B5')) break lab31
        this.bra = this.c
        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab31
        this.slice_from('\u03B1\u03B3\u03B1\u03BC')
      }
      this.c = this.limit - v_27
      const v_28: number = this.limit - this.c
      lab32: {
        this.ket = this.c
        if (this.find_among_b(a_35) === 0) break lab32
        this.bra = this.c
        this.slice_del()
        B_test1 = false
      }
      this.c = this.limit - v_28
      this.ket = this.c
      if (!this.eq_s_b('\u03B1\u03BC\u03B5')) break lab30
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_36) === 0) break lab30
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab30
      this.slice_from('\u03B1\u03BC')
    }
    this.c = this.limit - v_26
    const v_29: number = this.limit - this.c
    lab33: {
      const v_30: number = this.limit - this.c
      lab34: {
        this.ket = this.c
        if (this.find_among_b(a_38) === 0) break lab34
        this.bra = this.c
        this.slice_del()
        B_test1 = false
        this.ket = this.c
        this.bra = this.c
        if (this.find_among_b(a_37) === 0) break lab34
        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab34
        this.slice_from('\u03B1\u03B3\u03B1\u03BD')
      }
      this.c = this.limit - v_30
      this.ket = this.c
      if (!this.eq_s_b('\u03B1\u03BD\u03B5')) break lab33
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab35: {
        const v_31: number = this.limit - this.c
        lab36: {
          this.ket = this.c
          this.bra = this.c
          if (!this.in_grouping_b(g_v2, 945, 969)) break lab36
          this.slice_from('\u03B1\u03BD')
          break lab35
        }
        this.c = this.limit - v_31
        this.ket = this.c
      }
      this.bra = this.c
      if (this.find_among_b(a_39) === 0) break lab33
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab33
      this.slice_from('\u03B1\u03BD')
    }
    this.c = this.limit - v_29
    const v_32: number = this.limit - this.c
    lab37: {
      const v_33: number = this.limit - this.c
      lab38: {
        this.ket = this.c
        if (!this.eq_s_b('\u03B7\u03C3\u03B5\u03C4\u03B5')) break lab38
        this.bra = this.c
        this.slice_del()
        B_test1 = false
      }
      this.c = this.limit - v_33
      this.ket = this.c
      if (!this.eq_s_b('\u03B5\u03C4\u03B5')) break lab37
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab39: {
        const v_34: number = this.limit - this.c
        lab40: {
          this.ket = this.c
          this.bra = this.c
          if (!this.in_grouping_b(g_v2, 945, 969)) break lab40
          this.slice_from('\u03B5\u03C4')
          break lab39
        }
        this.c = this.limit - v_34
        lab41: {
          this.ket = this.c
          this.bra = this.c
          if (this.find_among_b(a_40) === 0) break lab41
          this.slice_from('\u03B5\u03C4')
          break lab39
        }
        this.c = this.limit - v_34
        this.ket = this.c
      }
      this.bra = this.c
      if (this.find_among_b(a_41) === 0) break lab37
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab37
      this.slice_from('\u03B5\u03C4')
    }
    this.c = this.limit - v_32
    const v_35: number = this.limit - this.c
    lab42: {
      this.ket = this.c
      if (this.find_among_b(a_42) === 0) break lab42
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab43: {
        const v_36: number = this.limit - this.c
        lab44: {
          this.ket = this.c
          this.bra = this.c
          if (!this.eq_s_b('\u03B1\u03C1\u03C7')) break lab44
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab44
          this.slice_from('\u03BF\u03BD\u03C4')
          break lab43
        }
        this.c = this.limit - v_36
        this.ket = this.c
        this.bra = this.c
        if (!this.eq_s_b('\u03BA\u03C1\u03B5')) break lab42
        this.slice_from('\u03C9\u03BD\u03C4')
      }
    }
    this.c = this.limit - v_35
    const v_37: number = this.limit - this.c
    lab45: {
      this.ket = this.c
      if (this.find_among_b(a_43) === 0) break lab45
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (!this.eq_s_b('\u03BF\u03BD')) break lab45
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab45
      this.slice_from('\u03BF\u03BC\u03B1\u03C3\u03C4')
    }
    this.c = this.limit - v_37
    const v_38: number = this.limit - this.c
    lab46: {
      const v_39: number = this.limit - this.c
      lab47: {
        this.ket = this.c
        if (!this.eq_s_b('\u03B9\u03B5\u03C3\u03C4\u03B5')) break lab47
        this.bra = this.c
        this.slice_del()
        B_test1 = false
        this.ket = this.c
        this.bra = this.c
        if (this.find_among_b(a_44) === 0) break lab47
        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab47
        this.slice_from('\u03B9\u03B5\u03C3\u03C4')
      }
      this.c = this.limit - v_39
      this.ket = this.c
      if (!this.eq_s_b('\u03B5\u03C3\u03C4\u03B5')) break lab46
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_45) === 0) break lab46
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab46
      this.slice_from('\u03B9\u03B5\u03C3\u03C4')
    }
    this.c = this.limit - v_38
    const v_40: number = this.limit - this.c
    lab48: {
      const v_41: number = this.limit - this.c
      lab49: {
        this.ket = this.c
        if (this.find_among_b(a_46) === 0) break lab49
        this.bra = this.c
        this.slice_del()
        B_test1 = false
      }
      this.c = this.limit - v_41
      this.ket = this.c
      if (this.find_among_b(a_49) === 0) break lab48
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab50: {
        const v_42: number = this.limit - this.c
        lab51: {
          this.ket = this.c
          this.bra = this.c
          if (this.find_among_b(a_47) === 0) break lab51
          this.slice_from('\u03B7\u03BA')
          break lab50
        }
        this.c = this.limit - v_42
        this.ket = this.c
        this.bra = this.c
        if (this.find_among_b(a_48) === 0) break lab48
        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab48
        this.slice_from('\u03B7\u03BA')
      }
    }
    this.c = this.limit - v_40
    const v_43: number = this.limit - this.c
    lab52: {
      this.ket = this.c
      if (this.find_among_b(a_52) === 0) break lab52
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab53: {
        const v_44: number = this.limit - this.c
        lab54: {
          this.ket = this.c
          this.bra = this.c
          if (this.find_among_b(a_50) === 0) break lab54
          this.slice_from('\u03BF\u03C5\u03C3')
          break lab53
        }
        this.c = this.limit - v_44
        this.ket = this.c
        this.bra = this.c
        if (this.find_among_b(a_51) === 0) break lab52
        if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab52
        this.slice_from('\u03BF\u03C5\u03C3')
      }
    }
    this.c = this.limit - v_43
    const v_45: number = this.limit - this.c
    lab55: {
      this.ket = this.c
      if (this.find_among_b(a_56) === 0) break lab55
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_57) === 0) break lab55
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab55
      this.slice_from('\u03B7\u03C3')
    }
    this.c = this.limit - v_45
    const v_46: number = this.limit - this.c
    lab56: {
      this.ket = this.c
      if (this.find_among_b(a_55) === 0) break lab56
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      lab57: {
        const v_47: number = this.limit - this.c
        lab58: {
          this.ket = this.c
          this.bra = this.c
          if (!this.eq_s_b('\u03BA\u03BF\u03BB\u03BB')) break lab58
          this.slice_from('\u03B1\u03B3')
          break lab57
        }
        this.c = this.limit - v_47
        lab59: {
          const v_48: number = this.limit - this.c
          lab60: {
            this.ket = this.c
            this.bra = this.c
            a = this.find_among_b(a_53)
            if (a === 0) break lab60
            switch (a) {
              case 1: {
                this.slice_from('\u03B1\u03B3')
                break
              }
            }
            break lab59
          }
          this.c = this.limit - v_48
          this.ket = this.c
          this.bra = this.c
          if (this.find_among_b(a_54) === 0) break lab56
          if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab56
          this.slice_from('\u03B1\u03B3')
        }
      }
    }
    this.c = this.limit - v_46
    const v_49: number = this.limit - this.c
    lab61: {
      this.ket = this.c
      if (!this.eq_s_b('\u03B7\u03C3\u03C4\u03B5')) break lab61
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_58) === 0) break lab61
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab61
      this.slice_from('\u03B7\u03C3\u03C4')
    }
    this.c = this.limit - v_49
    const v_50: number = this.limit - this.c
    lab62: {
      this.ket = this.c
      if (this.find_among_b(a_59) === 0) break lab62
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_60) === 0) break lab62
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab62
      this.slice_from('\u03BF\u03C5\u03BD')
    }
    this.c = this.limit - v_50
    const v_51: number = this.limit - this.c
    lab63: {
      this.ket = this.c
      if (this.find_among_b(a_61) === 0) break lab63
      this.bra = this.c
      this.slice_del()
      B_test1 = false
      this.ket = this.c
      this.bra = this.c
      if (this.find_among_b(a_62) === 0) break lab63
      if (/**@type {boolean}*/ (this.c > this.limit_backward)) break lab63
      this.slice_from('\u03BF\u03C5\u03BC')
    }
    this.c = this.limit - v_51
    const v_52: number = this.limit - this.c
    lab64: {
      const v_53: number = this.limit - this.c
      lab65: {
        this.ket = this.c
        if (this.find_among_b(a_63) === 0) break lab65
        this.bra = this.c
        this.slice_from('\u03BC\u03B1')
      }
      this.c = this.limit - v_53
      if (!B_test1) break lab64
      this.ket = this.c
      if (this.find_among_b(a_64) === 0) break lab64
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_52
    const v_54: number = this.limit - this.c
    lab66: {
      this.ket = this.c
      if (this.find_among_b(a_65) === 0) break lab66
      this.bra = this.c
      this.slice_del()
    }
    this.c = this.limit - v_54
    this.c = this.limit_backward
    return true
  }

  stem(input: string): string {
    this.setCurrent(input)
    this.#stem()
    return this.getCurrent()
  }
}

const shared = new GreekStemmer()

export function stem(token: string): string {
  return shared.stem(token)
}

export const revision = '4f02e255d00e5848'
