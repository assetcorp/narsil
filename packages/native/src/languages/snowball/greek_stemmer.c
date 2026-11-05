/*
 * Generated from algorithms/greek.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
 * UTF-16 code unit so that the stemmer reads the same units as the TypeScript stemmer.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors. The NOTICE file at the root
 * of the repository carries the licence. Source from https://github.com/snowballstem/snowball.git at
 * 6772636350acfd63797e8cd24ff86c70fd2df6fc, verified against https://github.com/snowballstem/snowball-data.git at
 * a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * packages/ts/snowball/build.ts writes this file, so regenerate it with that script.
 */

#if defined(__GNUC__)
#pragma GCC diagnostic ignored "-Wcast-align"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#endif

#include "greek_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int greek_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 0x3B1 };
static const symbol s_1[] = { 0x3B2 };
static const symbol s_2[] = { 0x3B3 };
static const symbol s_3[] = { 0x3B4 };
static const symbol s_4[] = { 0x3B5 };
static const symbol s_5[] = { 0x3B6 };
static const symbol s_6[] = { 0x3B7 };
static const symbol s_7[] = { 0x3B8 };
static const symbol s_8[] = { 0x3B9 };
static const symbol s_9[] = { 0x3BA };
static const symbol s_10[] = { 0x3BB };
static const symbol s_11[] = { 0x3BC };
static const symbol s_12[] = { 0x3BD };
static const symbol s_13[] = { 0x3BE };
static const symbol s_14[] = { 0x3BF };
static const symbol s_15[] = { 0x3C0 };
static const symbol s_16[] = { 0x3C1 };
static const symbol s_17[] = { 0x3C3 };
static const symbol s_18[] = { 0x3C4 };
static const symbol s_19[] = { 0x3C5 };
static const symbol s_20[] = { 0x3C6 };
static const symbol s_21[] = { 0x3C7 };
static const symbol s_22[] = { 0x3C8 };
static const symbol s_23[] = { 0x3C9 };
static const symbol s_24[] = { 0x3C6, 0x3B1 };
static const symbol s_25[] = { 0x3C3, 0x3BA, 0x3B1 };
static const symbol s_26[] = { 0x3BF, 0x3BB, 0x3BF };
static const symbol s_27[] = { 0x3C3, 0x3BF };
static const symbol s_28[] = { 0x3C4, 0x3B1, 0x3C4, 0x3BF };
static const symbol s_29[] = { 0x3BA, 0x3C1, 0x3B5 };
static const symbol s_30[] = { 0x3C0, 0x3B5, 0x3C1 };
static const symbol s_31[] = { 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_32[] = { 0x3C6, 0x3C9 };
static const symbol s_33[] = { 0x3BA, 0x3B1, 0x3B8, 0x3B5, 0x3C3, 0x3C4 };
static const symbol s_34[] = { 0x3B3, 0x3B5, 0x3B3, 0x3BF, 0x3BD };
static const symbol s_35[] = { 0x3B9 };
static const symbol s_36[] = { 0x3B9, 0x3B6 };
static const symbol s_37[] = { 0x3C9, 0x3BD };
static const symbol s_38[] = { 0x3B9, 0x3C3, 0x3B1 };
static const symbol s_39[] = { 0x3B9, 0x3C3 };
static const symbol s_40[] = { 0x3B9 };
static const symbol s_41[] = { 0x3B9, 0x3C3 };
static const symbol s_42[] = { 0x3B9 };
static const symbol s_43[] = { 0x3B9 };
static const symbol s_44[] = { 0x3B9, 0x3C3, 0x3C4 };
static const symbol s_45[] = { 0x3B9, 0x3C3, 0x3BC };
static const symbol s_46[] = { 0x3B9 };
static const symbol s_47[] = { 0x3B1, 0x3B3, 0x3BD, 0x3C9, 0x3C3, 0x3C4 };
static const symbol s_48[] = { 0x3B1, 0x3C4, 0x3BF, 0x3BC };
static const symbol s_49[] = { 0x3B3, 0x3BD, 0x3C9, 0x3C3, 0x3C4 };
static const symbol s_50[] = { 0x3B5, 0x3B8, 0x3BD };
static const symbol s_51[] = { 0x3B5, 0x3BA, 0x3BB, 0x3B5, 0x3BA, 0x3C4 };
static const symbol s_52[] = { 0x3C3, 0x3BA, 0x3B5, 0x3C0, 0x3C4 };
static const symbol s_53[] = { 0x3C4, 0x3BF, 0x3C0 };
static const symbol s_54[] = { 0x3B1, 0x3BB, 0x3B5, 0x3BE, 0x3B1, 0x3BD, 0x3B4, 0x3C1 };
static const symbol s_55[] = { 0x3B2, 0x3C5, 0x3B6, 0x3B1, 0x3BD, 0x3C4 };
static const symbol s_56[] = { 0x3B8, 0x3B5, 0x3B1, 0x3C4, 0x3C1 };
static const symbol s_57[] = { 0x3B1, 0x3C1, 0x3B1, 0x3BA };
static const symbol s_58[] = { 0x3B1, 0x3BA };
static const symbol s_59[] = { 0x3B9, 0x3C4, 0x3C3 };
static const symbol s_60[] = { 0x3BA, 0x3BF, 0x3C1 };
static const symbol s_61[] = { 0x3B9, 0x3C4, 0x3C3 };
static const symbol s_62[] = { 0x3B9, 0x3B4 };
static const symbol s_63[] = { 0x3B9, 0x3B4 };
static const symbol s_64[] = { 0x3B9, 0x3C3, 0x3BA };
static const symbol s_65[] = { 0x3B1, 0x3B4 };
static const symbol s_66[] = { 0x3B5, 0x3B4 };
static const symbol s_67[] = { 0x3BF, 0x3C5, 0x3B4 };
static const symbol s_68[] = { 0x3B5 };
static const symbol s_69[] = { 0x3B9 };
static const symbol s_70[] = { 0x3B9, 0x3BA };
static const symbol s_71[] = { 0x3B9, 0x3BA };
static const symbol s_72[] = { 0x3B1, 0x3B3, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_73[] = { 0x3B1, 0x3B3, 0x3B1, 0x3BC };
static const symbol s_74[] = { 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_75[] = { 0x3B1, 0x3BC };
static const symbol s_76[] = { 0x3B1, 0x3B3, 0x3B1, 0x3BD };
static const symbol s_77[] = { 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_78[] = { 0x3B1, 0x3BD };
static const symbol s_79[] = { 0x3B1, 0x3BD };
static const symbol s_80[] = { 0x3B7, 0x3C3, 0x3B5, 0x3C4, 0x3B5 };
static const symbol s_81[] = { 0x3B5, 0x3C4, 0x3B5 };
static const symbol s_82[] = { 0x3B5, 0x3C4 };
static const symbol s_83[] = { 0x3B5, 0x3C4 };
static const symbol s_84[] = { 0x3B5, 0x3C4 };
static const symbol s_85[] = { 0x3B1, 0x3C1, 0x3C7 };
static const symbol s_86[] = { 0x3BF, 0x3BD, 0x3C4 };
static const symbol s_87[] = { 0x3BA, 0x3C1, 0x3B5 };
static const symbol s_88[] = { 0x3C9, 0x3BD, 0x3C4 };
static const symbol s_89[] = { 0x3BF, 0x3BD };
static const symbol s_90[] = { 0x3BF, 0x3BC, 0x3B1, 0x3C3, 0x3C4 };
static const symbol s_91[] = { 0x3B9, 0x3B5, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_92[] = { 0x3B9, 0x3B5, 0x3C3, 0x3C4 };
static const symbol s_93[] = { 0x3B5, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_94[] = { 0x3B9, 0x3B5, 0x3C3, 0x3C4 };
static const symbol s_95[] = { 0x3B7, 0x3BA };
static const symbol s_96[] = { 0x3B7, 0x3BA };
static const symbol s_97[] = { 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_98[] = { 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_99[] = { 0x3B7, 0x3C3 };
static const symbol s_100[] = { 0x3BA, 0x3BF, 0x3BB, 0x3BB };
static const symbol s_101[] = { 0x3B1, 0x3B3 };
static const symbol s_102[] = { 0x3B1, 0x3B3 };
static const symbol s_103[] = { 0x3B1, 0x3B3 };
static const symbol s_104[] = { 0x3B7, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_105[] = { 0x3B7, 0x3C3, 0x3C4 };
static const symbol s_106[] = { 0x3BF, 0x3C5, 0x3BD };
static const symbol s_107[] = { 0x3BF, 0x3C5, 0x3BC };
static const symbol s_108[] = { 0x3BC, 0x3B1 };

static const symbol s_0_1[1] = { 0x386 };
static const symbol s_0_2[1] = { 0x388 };
static const symbol s_0_3[1] = { 0x389 };
static const symbol s_0_4[1] = { 0x38A };
static const symbol s_0_5[1] = { 0x38C };
static const symbol s_0_6[1] = { 0x38E };
static const symbol s_0_7[1] = { 0x38F };
static const symbol s_0_8[1] = { 0x390 };
static const symbol s_0_9[1] = { 0x391 };
static const symbol s_0_10[1] = { 0x392 };
static const symbol s_0_11[1] = { 0x393 };
static const symbol s_0_12[1] = { 0x394 };
static const symbol s_0_13[1] = { 0x395 };
static const symbol s_0_14[1] = { 0x396 };
static const symbol s_0_15[1] = { 0x397 };
static const symbol s_0_16[1] = { 0x398 };
static const symbol s_0_17[1] = { 0x399 };
static const symbol s_0_18[1] = { 0x39A };
static const symbol s_0_19[1] = { 0x39B };
static const symbol s_0_20[1] = { 0x39C };
static const symbol s_0_21[1] = { 0x39D };
static const symbol s_0_22[1] = { 0x39E };
static const symbol s_0_23[1] = { 0x39F };
static const symbol s_0_24[1] = { 0x3A0 };
static const symbol s_0_25[1] = { 0x3A1 };
static const symbol s_0_26[1] = { 0x3A3 };
static const symbol s_0_27[1] = { 0x3A4 };
static const symbol s_0_28[1] = { 0x3A5 };
static const symbol s_0_29[1] = { 0x3A6 };
static const symbol s_0_30[1] = { 0x3A7 };
static const symbol s_0_31[1] = { 0x3A8 };
static const symbol s_0_32[1] = { 0x3A9 };
static const symbol s_0_33[1] = { 0x3AA };
static const symbol s_0_34[1] = { 0x3AB };
static const symbol s_0_35[1] = { 0x3AC };
static const symbol s_0_36[1] = { 0x3AD };
static const symbol s_0_37[1] = { 0x3AE };
static const symbol s_0_38[1] = { 0x3AF };
static const symbol s_0_39[1] = { 0x3B0 };
static const symbol s_0_40[1] = { 0x3C2 };
static const symbol s_0_41[1] = { 0x3CA };
static const symbol s_0_42[1] = { 0x3CB };
static const symbol s_0_43[1] = { 0x3CC };
static const symbol s_0_44[1] = { 0x3CD };
static const symbol s_0_45[1] = { 0x3CE };
static const struct among a_0[46] = {
{ 0, 0, 0, 25, 0},
{ 1, s_0_1, -1, 1, 0},
{ 1, s_0_2, -2, 5, 0},
{ 1, s_0_3, -3, 7, 0},
{ 1, s_0_4, -4, 9, 0},
{ 1, s_0_5, -5, 15, 0},
{ 1, s_0_6, -6, 20, 0},
{ 1, s_0_7, -7, 24, 0},
{ 1, s_0_8, -8, 7, 0},
{ 1, s_0_9, -9, 1, 0},
{ 1, s_0_10, -10, 2, 0},
{ 1, s_0_11, -11, 3, 0},
{ 1, s_0_12, -12, 4, 0},
{ 1, s_0_13, -13, 5, 0},
{ 1, s_0_14, -14, 6, 0},
{ 1, s_0_15, -15, 7, 0},
{ 1, s_0_16, -16, 8, 0},
{ 1, s_0_17, -17, 9, 0},
{ 1, s_0_18, -18, 10, 0},
{ 1, s_0_19, -19, 11, 0},
{ 1, s_0_20, -20, 12, 0},
{ 1, s_0_21, -21, 13, 0},
{ 1, s_0_22, -22, 14, 0},
{ 1, s_0_23, -23, 15, 0},
{ 1, s_0_24, -24, 16, 0},
{ 1, s_0_25, -25, 17, 0},
{ 1, s_0_26, -26, 18, 0},
{ 1, s_0_27, -27, 19, 0},
{ 1, s_0_28, -28, 20, 0},
{ 1, s_0_29, -29, 21, 0},
{ 1, s_0_30, -30, 22, 0},
{ 1, s_0_31, -31, 23, 0},
{ 1, s_0_32, -32, 24, 0},
{ 1, s_0_33, -33, 9, 0},
{ 1, s_0_34, -34, 20, 0},
{ 1, s_0_35, -35, 1, 0},
{ 1, s_0_36, -36, 5, 0},
{ 1, s_0_37, -37, 7, 0},
{ 1, s_0_38, -38, 9, 0},
{ 1, s_0_39, -39, 20, 0},
{ 1, s_0_40, -40, 18, 0},
{ 1, s_0_41, -41, 7, 0},
{ 1, s_0_42, -42, 20, 0},
{ 1, s_0_43, -43, 15, 0},
{ 1, s_0_44, -44, 20, 0},
{ 1, s_0_45, -45, 24, 0}
};

static const symbol s_1_0[6] = { 0x3C3, 0x3BA, 0x3B1, 0x3B3, 0x3B9, 0x3B1 };
static const symbol s_1_1[5] = { 0x3C6, 0x3B1, 0x3B3, 0x3B9, 0x3B1 };
static const symbol s_1_2[6] = { 0x3BF, 0x3BB, 0x3BF, 0x3B3, 0x3B9, 0x3B1 };
static const symbol s_1_3[5] = { 0x3C3, 0x3BF, 0x3B3, 0x3B9, 0x3B1 };
static const symbol s_1_4[7] = { 0x3C4, 0x3B1, 0x3C4, 0x3BF, 0x3B3, 0x3B9, 0x3B1 };
static const symbol s_1_5[6] = { 0x3BA, 0x3C1, 0x3B5, 0x3B1, 0x3C4, 0x3B1 };
static const symbol s_1_6[6] = { 0x3C0, 0x3B5, 0x3C1, 0x3B1, 0x3C4, 0x3B1 };
static const symbol s_1_7[6] = { 0x3C4, 0x3B5, 0x3C1, 0x3B1, 0x3C4, 0x3B1 };
static const symbol s_1_8[8] = { 0x3B3, 0x3B5, 0x3B3, 0x3BF, 0x3BD, 0x3BF, 0x3C4, 0x3B1 };
static const symbol s_1_9[9] = { 0x3BA, 0x3B1, 0x3B8, 0x3B5, 0x3C3, 0x3C4, 0x3C9, 0x3C4, 0x3B1 };
static const symbol s_1_10[4] = { 0x3C6, 0x3C9, 0x3C4, 0x3B1 };
static const symbol s_1_11[6] = { 0x3C0, 0x3B5, 0x3C1, 0x3B1, 0x3C4, 0x3B7 };
static const symbol s_1_12[7] = { 0x3C3, 0x3BA, 0x3B1, 0x3B3, 0x3B9, 0x3C9, 0x3BD };
static const symbol s_1_13[6] = { 0x3C6, 0x3B1, 0x3B3, 0x3B9, 0x3C9, 0x3BD };
static const symbol s_1_14[7] = { 0x3BF, 0x3BB, 0x3BF, 0x3B3, 0x3B9, 0x3C9, 0x3BD };
static const symbol s_1_15[6] = { 0x3C3, 0x3BF, 0x3B3, 0x3B9, 0x3C9, 0x3BD };
static const symbol s_1_16[8] = { 0x3C4, 0x3B1, 0x3C4, 0x3BF, 0x3B3, 0x3B9, 0x3C9, 0x3BD };
static const symbol s_1_17[7] = { 0x3BA, 0x3C1, 0x3B5, 0x3B1, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_1_18[7] = { 0x3C0, 0x3B5, 0x3C1, 0x3B1, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_1_19[7] = { 0x3C4, 0x3B5, 0x3C1, 0x3B1, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_1_20[9] = { 0x3B3, 0x3B5, 0x3B3, 0x3BF, 0x3BD, 0x3BF, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_1_21[10] = { 0x3BA, 0x3B1, 0x3B8, 0x3B5, 0x3C3, 0x3C4, 0x3C9, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_1_22[5] = { 0x3C6, 0x3C9, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_1_23[5] = { 0x3BA, 0x3C1, 0x3B5, 0x3B1, 0x3C3 };
static const symbol s_1_24[5] = { 0x3C0, 0x3B5, 0x3C1, 0x3B1, 0x3C3 };
static const symbol s_1_25[5] = { 0x3C4, 0x3B5, 0x3C1, 0x3B1, 0x3C3 };
static const symbol s_1_26[7] = { 0x3B3, 0x3B5, 0x3B3, 0x3BF, 0x3BD, 0x3BF, 0x3C3 };
static const symbol s_1_27[7] = { 0x3BA, 0x3C1, 0x3B5, 0x3B1, 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_1_28[7] = { 0x3C0, 0x3B5, 0x3C1, 0x3B1, 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_1_29[7] = { 0x3C4, 0x3B5, 0x3C1, 0x3B1, 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_1_30[9] = { 0x3B3, 0x3B5, 0x3B3, 0x3BF, 0x3BD, 0x3BF, 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_1_31[10] = { 0x3BA, 0x3B1, 0x3B8, 0x3B5, 0x3C3, 0x3C4, 0x3C9, 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_1_32[5] = { 0x3C6, 0x3C9, 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_1_33[8] = { 0x3BA, 0x3B1, 0x3B8, 0x3B5, 0x3C3, 0x3C4, 0x3C9, 0x3C3 };
static const symbol s_1_34[3] = { 0x3C6, 0x3C9, 0x3C3 };
static const symbol s_1_35[7] = { 0x3C3, 0x3BA, 0x3B1, 0x3B3, 0x3B9, 0x3BF, 0x3C5 };
static const symbol s_1_36[6] = { 0x3C6, 0x3B1, 0x3B3, 0x3B9, 0x3BF, 0x3C5 };
static const symbol s_1_37[7] = { 0x3BF, 0x3BB, 0x3BF, 0x3B3, 0x3B9, 0x3BF, 0x3C5 };
static const symbol s_1_38[6] = { 0x3C3, 0x3BF, 0x3B3, 0x3B9, 0x3BF, 0x3C5 };
static const symbol s_1_39[8] = { 0x3C4, 0x3B1, 0x3C4, 0x3BF, 0x3B3, 0x3B9, 0x3BF, 0x3C5 };
static const struct among a_1[40] = {
{ 6, s_1_0, 0, 2, 0},
{ 5, s_1_1, 0, 1, 0},
{ 6, s_1_2, 0, 3, 0},
{ 5, s_1_3, 0, 4, 0},
{ 7, s_1_4, 0, 5, 0},
{ 6, s_1_5, 0, 6, 0},
{ 6, s_1_6, 0, 7, 0},
{ 6, s_1_7, 0, 8, 0},
{ 8, s_1_8, 0, 11, 0},
{ 9, s_1_9, 0, 10, 0},
{ 4, s_1_10, 0, 9, 0},
{ 6, s_1_11, 0, 7, 0},
{ 7, s_1_12, 0, 2, 0},
{ 6, s_1_13, 0, 1, 0},
{ 7, s_1_14, 0, 3, 0},
{ 6, s_1_15, 0, 4, 0},
{ 8, s_1_16, 0, 5, 0},
{ 7, s_1_17, 0, 6, 0},
{ 7, s_1_18, 0, 7, 0},
{ 7, s_1_19, 0, 8, 0},
{ 9, s_1_20, 0, 11, 0},
{ 10, s_1_21, 0, 10, 0},
{ 5, s_1_22, 0, 9, 0},
{ 5, s_1_23, 0, 6, 0},
{ 5, s_1_24, 0, 7, 0},
{ 5, s_1_25, 0, 8, 0},
{ 7, s_1_26, 0, 11, 0},
{ 7, s_1_27, 0, 6, 0},
{ 7, s_1_28, 0, 7, 0},
{ 7, s_1_29, 0, 8, 0},
{ 9, s_1_30, 0, 11, 0},
{ 10, s_1_31, 0, 10, 0},
{ 5, s_1_32, 0, 9, 0},
{ 8, s_1_33, 0, 10, 0},
{ 3, s_1_34, 0, 9, 0},
{ 7, s_1_35, 0, 2, 0},
{ 6, s_1_36, 0, 1, 0},
{ 7, s_1_37, 0, 3, 0},
{ 6, s_1_38, 0, 4, 0},
{ 8, s_1_39, 0, 5, 0}
};

static const symbol s_2_0[2] = { 0x3C0, 0x3B1 };
static const symbol s_2_1[6] = { 0x3BE, 0x3B1, 0x3BD, 0x3B1, 0x3C0, 0x3B1 };
static const symbol s_2_2[3] = { 0x3B5, 0x3C0, 0x3B1 };
static const symbol s_2_3[6] = { 0x3C0, 0x3B5, 0x3C1, 0x3B9, 0x3C0, 0x3B1 };
static const symbol s_2_4[6] = { 0x3B1, 0x3BD, 0x3B1, 0x3BC, 0x3C0, 0x3B1 };
static const symbol s_2_5[4] = { 0x3B5, 0x3BC, 0x3C0, 0x3B1 };
static const symbol s_2_6[1] = { 0x3B2 };
static const symbol s_2_7[4] = { 0x3B4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_2_8[6] = { 0x3B2, 0x3B1, 0x3B8, 0x3C5, 0x3C1, 0x3B9 };
static const symbol s_2_9[4] = { 0x3B2, 0x3B1, 0x3C1, 0x3BA };
static const symbol s_2_10[4] = { 0x3BC, 0x3B1, 0x3C1, 0x3BA };
static const symbol s_2_11[1] = { 0x3BB };
static const symbol s_2_12[1] = { 0x3BC };
static const symbol s_2_13[4] = { 0x3BA, 0x3BF, 0x3C1, 0x3BD };
static const symbol s_2_14[4] = { 0x3B1, 0x3B8, 0x3C1, 0x3BF };
static const symbol s_2_15[7] = { 0x3C3, 0x3C5, 0x3BD, 0x3B1, 0x3B8, 0x3C1, 0x3BF };
static const symbol s_2_16[1] = { 0x3C0 };
static const symbol s_2_17[3] = { 0x3B9, 0x3BC, 0x3C0 };
static const symbol s_2_18[1] = { 0x3C1 };
static const symbol s_2_19[3] = { 0x3BC, 0x3B1, 0x3C1 };
static const symbol s_2_20[5] = { 0x3B1, 0x3BC, 0x3C0, 0x3B1, 0x3C1 };
static const symbol s_2_21[3] = { 0x3B3, 0x3BA, 0x3C1 };
static const symbol s_2_22[6] = { 0x3B2, 0x3BF, 0x3BB, 0x3B2, 0x3BF, 0x3C1 };
static const symbol s_2_23[6] = { 0x3B3, 0x3BB, 0x3C5, 0x3BA, 0x3BF, 0x3C1 };
static const symbol s_2_24[7] = { 0x3C0, 0x3B9, 0x3C0, 0x3B5, 0x3C1, 0x3BF, 0x3C1 };
static const symbol s_2_25[2] = { 0x3C0, 0x3C1 };
static const symbol s_2_26[3] = { 0x3BC, 0x3C0, 0x3C1 };
static const symbol s_2_27[3] = { 0x3B1, 0x3C1, 0x3C1 };
static const symbol s_2_28[6] = { 0x3B3, 0x3BB, 0x3C5, 0x3BA, 0x3C5, 0x3C1 };
static const symbol s_2_29[5] = { 0x3C0, 0x3BF, 0x3BB, 0x3C5, 0x3C1 };
static const symbol s_2_30[3] = { 0x3BB, 0x3BF, 0x3C5 };
static const struct among a_2[31] = {
{ 2, s_2_0, 0, 1, 0},
{ 6, s_2_1, -1, 1, 0},
{ 3, s_2_2, -2, 1, 0},
{ 6, s_2_3, -3, 1, 0},
{ 6, s_2_4, -4, 1, 0},
{ 4, s_2_5, -5, 1, 0},
{ 1, s_2_6, 0, 2, 0},
{ 4, s_2_7, 0, 1, 0},
{ 6, s_2_8, 0, 2, 0},
{ 4, s_2_9, 0, 2, 0},
{ 4, s_2_10, 0, 2, 0},
{ 1, s_2_11, 0, 2, 0},
{ 1, s_2_12, 0, 2, 0},
{ 4, s_2_13, 0, 2, 0},
{ 4, s_2_14, 0, 1, 0},
{ 7, s_2_15, -1, 1, 0},
{ 1, s_2_16, 0, 2, 0},
{ 3, s_2_17, -1, 2, 0},
{ 1, s_2_18, 0, 2, 0},
{ 3, s_2_19, -1, 2, 0},
{ 5, s_2_20, -2, 2, 0},
{ 3, s_2_21, -3, 2, 0},
{ 6, s_2_22, -4, 2, 0},
{ 6, s_2_23, -5, 2, 0},
{ 7, s_2_24, -6, 2, 0},
{ 2, s_2_25, -7, 2, 0},
{ 3, s_2_26, -1, 2, 0},
{ 3, s_2_27, -9, 2, 0},
{ 6, s_2_28, -10, 2, 0},
{ 5, s_2_29, -11, 2, 0},
{ 3, s_2_30, 0, 2, 0}
};

static const symbol s_3_0[3] = { 0x3B9, 0x3B6, 0x3B1 };
static const symbol s_3_1[3] = { 0x3B9, 0x3B6, 0x3B5 };
static const symbol s_3_2[5] = { 0x3B9, 0x3B6, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_3_3[6] = { 0x3B9, 0x3B6, 0x3BF, 0x3C5, 0x3BC, 0x3B5 };
static const symbol s_3_4[5] = { 0x3B9, 0x3B6, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_3_5[6] = { 0x3B9, 0x3B6, 0x3BF, 0x3C5, 0x3BD, 0x3B5 };
static const symbol s_3_6[5] = { 0x3B9, 0x3B6, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_3_7[5] = { 0x3B9, 0x3B6, 0x3B5, 0x3C4, 0x3B5 };
static const symbol s_3_8[4] = { 0x3B9, 0x3B6, 0x3B5, 0x3B9 };
static const symbol s_3_9[4] = { 0x3B9, 0x3B6, 0x3B1, 0x3BD };
static const symbol s_3_10[5] = { 0x3B9, 0x3B6, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_3_11[4] = { 0x3B9, 0x3B6, 0x3B5, 0x3C3 };
static const symbol s_3_12[5] = { 0x3B9, 0x3B6, 0x3B5, 0x3B9, 0x3C3 };
static const symbol s_3_13[3] = { 0x3B9, 0x3B6, 0x3C9 };
static const struct among a_3[14] = {
{ 3, s_3_0, 0, 1, 0},
{ 3, s_3_1, 0, 1, 0},
{ 5, s_3_2, 0, 1, 0},
{ 6, s_3_3, 0, 1, 0},
{ 5, s_3_4, 0, 1, 0},
{ 6, s_3_5, 0, 1, 0},
{ 5, s_3_6, 0, 1, 0},
{ 5, s_3_7, 0, 1, 0},
{ 4, s_3_8, 0, 1, 0},
{ 4, s_3_9, 0, 1, 0},
{ 5, s_3_10, 0, 1, 0},
{ 4, s_3_11, 0, 1, 0},
{ 5, s_3_12, 0, 1, 0},
{ 3, s_3_13, 0, 1, 0}
};

static const symbol s_4_0[2] = { 0x3B2, 0x3B9 };
static const symbol s_4_1[2] = { 0x3BB, 0x3B9 };
static const symbol s_4_2[2] = { 0x3B1, 0x3BB };
static const symbol s_4_3[2] = { 0x3B5, 0x3BD };
static const symbol s_4_4[1] = { 0x3C3 };
static const symbol s_4_5[1] = { 0x3C7 };
static const symbol s_4_6[2] = { 0x3C5, 0x3C8 };
static const symbol s_4_7[2] = { 0x3B6, 0x3C9 };
static const struct among a_4[8] = {
{ 2, s_4_0, 0, 1, 0},
{ 2, s_4_1, 0, 1, 0},
{ 2, s_4_2, 0, 1, 0},
{ 2, s_4_3, 0, 1, 0},
{ 1, s_4_4, 0, 1, 0},
{ 1, s_4_5, 0, 1, 0},
{ 2, s_4_6, 0, 1, 0},
{ 2, s_4_7, 0, 1, 0}
};

static const symbol s_5_0[5] = { 0x3C9, 0x3B8, 0x3B7, 0x3BA, 0x3B1 };
static const symbol s_5_1[5] = { 0x3C9, 0x3B8, 0x3B7, 0x3BA, 0x3B5 };
static const symbol s_5_2[7] = { 0x3C9, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_5_3[7] = { 0x3C9, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_5_4[7] = { 0x3C9, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_5_5[6] = { 0x3C9, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3BD };
static const symbol s_5_6[6] = { 0x3C9, 0x3B8, 0x3B7, 0x3BA, 0x3B5, 0x3C3 };
static const struct among a_5[7] = {
{ 5, s_5_0, 0, 1, 0},
{ 5, s_5_1, 0, 1, 0},
{ 7, s_5_2, 0, 1, 0},
{ 7, s_5_3, 0, 1, 0},
{ 7, s_5_4, 0, 1, 0},
{ 6, s_5_5, 0, 1, 0},
{ 6, s_5_6, 0, 1, 0}
};

static const symbol s_6_0[6] = { 0x3BE, 0x3B1, 0x3BD, 0x3B1, 0x3C0, 0x3B1 };
static const symbol s_6_1[3] = { 0x3B5, 0x3C0, 0x3B1 };
static const symbol s_6_2[6] = { 0x3C0, 0x3B5, 0x3C1, 0x3B9, 0x3C0, 0x3B1 };
static const symbol s_6_3[6] = { 0x3B1, 0x3BD, 0x3B1, 0x3BC, 0x3C0, 0x3B1 };
static const symbol s_6_4[4] = { 0x3B5, 0x3BC, 0x3C0, 0x3B1 };
static const symbol s_6_5[7] = { 0x3C7, 0x3B1, 0x3C1, 0x3C4, 0x3BF, 0x3C0, 0x3B1 };
static const symbol s_6_6[6] = { 0x3B5, 0x3BE, 0x3B1, 0x3C1, 0x3C7, 0x3B1 };
static const symbol s_6_7[2] = { 0x3B3, 0x3B5 };
static const symbol s_6_8[3] = { 0x3B3, 0x3BA, 0x3B5 };
static const symbol s_6_9[3] = { 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_6_10[4] = { 0x3B5, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_6_11[6] = { 0x3B1, 0x3C0, 0x3B5, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_6_12[6] = { 0x3B1, 0x3C0, 0x3BF, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_6_13[6] = { 0x3B5, 0x3C3, 0x3C9, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_6_14[4] = { 0x3B4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_6_15[2] = { 0x3C0, 0x3B5 };
static const symbol s_6_16[3] = { 0x3B5, 0x3C0, 0x3B5 };
static const symbol s_6_17[6] = { 0x3BC, 0x3B5, 0x3C4, 0x3B5, 0x3C0, 0x3B5 };
static const symbol s_6_18[3] = { 0x3B5, 0x3C3, 0x3B5 };
static const symbol s_6_19[2] = { 0x3B3, 0x3BA };
static const symbol s_6_20[1] = { 0x3BC };
static const symbol s_6_21[6] = { 0x3C0, 0x3BF, 0x3C5, 0x3BA, 0x3B1, 0x3BC };
static const symbol s_6_22[3] = { 0x3BA, 0x3BF, 0x3BC };
static const symbol s_6_23[2] = { 0x3B1, 0x3BD };
static const symbol s_6_24[3] = { 0x3BF, 0x3BB, 0x3BF };
static const symbol s_6_25[4] = { 0x3B1, 0x3B8, 0x3C1, 0x3BF };
static const symbol s_6_26[7] = { 0x3C3, 0x3C5, 0x3BD, 0x3B1, 0x3B8, 0x3C1, 0x3BF };
static const symbol s_6_27[1] = { 0x3C0 };
static const symbol s_6_28[3] = { 0x3BB, 0x3B1, 0x3C1 };
static const symbol s_6_29[8] = { 0x3B4, 0x3B7, 0x3BC, 0x3BF, 0x3BA, 0x3C1, 0x3B1, 0x3C4 };
static const symbol s_6_30[2] = { 0x3B1, 0x3C6 };
static const symbol s_6_31[9] = { 0x3B3, 0x3B9, 0x3B3, 0x3B1, 0x3BD, 0x3C4, 0x3BF, 0x3B1, 0x3C6 };
static const struct among a_6[32] = {
{ 6, s_6_0, 0, 1, 0},
{ 3, s_6_1, 0, 1, 0},
{ 6, s_6_2, 0, 1, 0},
{ 6, s_6_3, 0, 1, 0},
{ 4, s_6_4, 0, 1, 0},
{ 7, s_6_5, 0, 1, 0},
{ 6, s_6_6, 0, 1, 0},
{ 2, s_6_7, 0, 2, 0},
{ 3, s_6_8, 0, 2, 0},
{ 3, s_6_9, 0, 1, 0},
{ 4, s_6_10, -1, 1, 0},
{ 6, s_6_11, -1, 1, 0},
{ 6, s_6_12, -3, 1, 0},
{ 6, s_6_13, -4, 1, 0},
{ 4, s_6_14, 0, 1, 0},
{ 2, s_6_15, 0, 1, 0},
{ 3, s_6_16, -1, 1, 0},
{ 6, s_6_17, -1, 1, 0},
{ 3, s_6_18, 0, 1, 0},
{ 2, s_6_19, 0, 2, 0},
{ 1, s_6_20, 0, 2, 0},
{ 6, s_6_21, -1, 2, 0},
{ 3, s_6_22, -2, 2, 0},
{ 2, s_6_23, 0, 2, 0},
{ 3, s_6_24, 0, 2, 0},
{ 4, s_6_25, 0, 1, 0},
{ 7, s_6_26, -1, 1, 0},
{ 1, s_6_27, 0, 2, 0},
{ 3, s_6_28, 0, 2, 0},
{ 8, s_6_29, 0, 2, 0},
{ 2, s_6_30, 0, 2, 0},
{ 9, s_6_31, -1, 2, 0}
};

static const symbol s_7_0[3] = { 0x3B9, 0x3C3, 0x3B1 };
static const symbol s_7_1[5] = { 0x3B9, 0x3C3, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_7_2[5] = { 0x3B9, 0x3C3, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_7_3[3] = { 0x3B9, 0x3C3, 0x3B5 };
static const symbol s_7_4[5] = { 0x3B9, 0x3C3, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_7_5[4] = { 0x3B9, 0x3C3, 0x3B1, 0x3BD };
static const symbol s_7_6[4] = { 0x3B9, 0x3C3, 0x3B5, 0x3C3 };
static const struct among a_7[7] = {
{ 3, s_7_0, 0, 1, 0},
{ 5, s_7_1, 0, 1, 0},
{ 5, s_7_2, 0, 1, 0},
{ 3, s_7_3, 0, 1, 0},
{ 5, s_7_4, 0, 1, 0},
{ 4, s_7_5, 0, 1, 0},
{ 4, s_7_6, 0, 1, 0}
};

static const symbol s_8_0[6] = { 0x3BE, 0x3B1, 0x3BD, 0x3B1, 0x3C0, 0x3B1 };
static const symbol s_8_1[3] = { 0x3B5, 0x3C0, 0x3B1 };
static const symbol s_8_2[6] = { 0x3C0, 0x3B5, 0x3C1, 0x3B9, 0x3C0, 0x3B1 };
static const symbol s_8_3[6] = { 0x3B1, 0x3BD, 0x3B1, 0x3BC, 0x3C0, 0x3B1 };
static const symbol s_8_4[4] = { 0x3B5, 0x3BC, 0x3C0, 0x3B1 };
static const symbol s_8_5[7] = { 0x3C7, 0x3B1, 0x3C1, 0x3C4, 0x3BF, 0x3C0, 0x3B1 };
static const symbol s_8_6[6] = { 0x3B5, 0x3BE, 0x3B1, 0x3C1, 0x3C7, 0x3B1 };
static const symbol s_8_7[3] = { 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_8_8[4] = { 0x3B5, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_8_9[6] = { 0x3B1, 0x3C0, 0x3B5, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_8_10[6] = { 0x3B1, 0x3C0, 0x3BF, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_8_11[6] = { 0x3B5, 0x3C3, 0x3C9, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_8_12[4] = { 0x3B4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_8_13[2] = { 0x3C0, 0x3B5 };
static const symbol s_8_14[3] = { 0x3B5, 0x3C0, 0x3B5 };
static const symbol s_8_15[6] = { 0x3BC, 0x3B5, 0x3C4, 0x3B5, 0x3C0, 0x3B5 };
static const symbol s_8_16[3] = { 0x3B5, 0x3C3, 0x3B5 };
static const symbol s_8_17[4] = { 0x3B1, 0x3B8, 0x3C1, 0x3BF };
static const symbol s_8_18[7] = { 0x3C3, 0x3C5, 0x3BD, 0x3B1, 0x3B8, 0x3C1, 0x3BF };
static const struct among a_8[19] = {
{ 6, s_8_0, 0, 1, 0},
{ 3, s_8_1, 0, 1, 0},
{ 6, s_8_2, 0, 1, 0},
{ 6, s_8_3, 0, 1, 0},
{ 4, s_8_4, 0, 1, 0},
{ 7, s_8_5, 0, 1, 0},
{ 6, s_8_6, 0, 1, 0},
{ 3, s_8_7, 0, 1, 0},
{ 4, s_8_8, -1, 1, 0},
{ 6, s_8_9, -1, 1, 0},
{ 6, s_8_10, -3, 1, 0},
{ 6, s_8_11, -4, 1, 0},
{ 4, s_8_12, 0, 1, 0},
{ 2, s_8_13, 0, 1, 0},
{ 3, s_8_14, -1, 1, 0},
{ 6, s_8_15, -1, 1, 0},
{ 3, s_8_16, 0, 1, 0},
{ 4, s_8_17, 0, 1, 0},
{ 7, s_8_18, -1, 1, 0}
};

static const symbol s_9_0[6] = { 0x3B9, 0x3C3, 0x3BF, 0x3C5, 0x3BC, 0x3B5 };
static const symbol s_9_1[6] = { 0x3B9, 0x3C3, 0x3BF, 0x3C5, 0x3BD, 0x3B5 };
static const symbol s_9_2[5] = { 0x3B9, 0x3C3, 0x3B5, 0x3C4, 0x3B5 };
static const symbol s_9_3[4] = { 0x3B9, 0x3C3, 0x3B5, 0x3B9 };
static const symbol s_9_4[5] = { 0x3B9, 0x3C3, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_9_5[5] = { 0x3B9, 0x3C3, 0x3B5, 0x3B9, 0x3C3 };
static const symbol s_9_6[3] = { 0x3B9, 0x3C3, 0x3C9 };
static const struct among a_9[7] = {
{ 6, s_9_0, 0, 1, 0},
{ 6, s_9_1, 0, 1, 0},
{ 5, s_9_2, 0, 1, 0},
{ 4, s_9_3, 0, 1, 0},
{ 5, s_9_4, 0, 1, 0},
{ 5, s_9_5, 0, 1, 0},
{ 3, s_9_6, 0, 1, 0}
};

static const symbol s_10_0[3] = { 0x3B1, 0x3C4, 0x3B1 };
static const symbol s_10_1[2] = { 0x3C6, 0x3B1 };
static const symbol s_10_2[3] = { 0x3B7, 0x3C6, 0x3B1 };
static const symbol s_10_3[3] = { 0x3BC, 0x3B5, 0x3B3 };
static const symbol s_10_4[3] = { 0x3BB, 0x3C5, 0x3B3 };
static const symbol s_10_5[2] = { 0x3B7, 0x3B4 };
static const symbol s_10_6[3] = { 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_10_7[6] = { 0x3B5, 0x3C3, 0x3C9, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_10_8[3] = { 0x3C0, 0x3BB, 0x3B5 };
static const symbol s_10_9[4] = { 0x3B4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_10_10[2] = { 0x3C3, 0x3B5 };
static const symbol s_10_11[3] = { 0x3B1, 0x3C3, 0x3B5 };
static const symbol s_10_12[3] = { 0x3BA, 0x3B1, 0x3B8 };
static const symbol s_10_13[3] = { 0x3B5, 0x3C7, 0x3B8 };
static const symbol s_10_14[3] = { 0x3BA, 0x3B1, 0x3BA };
static const symbol s_10_15[3] = { 0x3BC, 0x3B1, 0x3BA };
static const symbol s_10_16[2] = { 0x3C3, 0x3BA };
static const symbol s_10_17[3] = { 0x3C6, 0x3B9, 0x3BB };
static const symbol s_10_18[3] = { 0x3BA, 0x3C5, 0x3BB };
static const symbol s_10_19[1] = { 0x3BC };
static const symbol s_10_20[3] = { 0x3B3, 0x3B5, 0x3BC };
static const symbol s_10_21[3] = { 0x3B1, 0x3C7, 0x3BD };
static const symbol s_10_22[7] = { 0x3C3, 0x3C5, 0x3BD, 0x3B1, 0x3B8, 0x3C1, 0x3BF };
static const symbol s_10_23[1] = { 0x3C0 };
static const symbol s_10_24[2] = { 0x3B1, 0x3C0 };
static const symbol s_10_25[3] = { 0x3B5, 0x3BC, 0x3C0 };
static const symbol s_10_26[3] = { 0x3B5, 0x3C5, 0x3C0 };
static const symbol s_10_27[2] = { 0x3B1, 0x3C1 };
static const symbol s_10_28[3] = { 0x3B1, 0x3BF, 0x3C1 };
static const symbol s_10_29[3] = { 0x3B3, 0x3C5, 0x3C1 };
static const symbol s_10_30[2] = { 0x3C7, 0x3C1 };
static const symbol s_10_31[3] = { 0x3C7, 0x3C9, 0x3C1 };
static const symbol s_10_32[2] = { 0x3BA, 0x3C4 };
static const symbol s_10_33[3] = { 0x3B1, 0x3BA, 0x3C4 };
static const symbol s_10_34[2] = { 0x3C7, 0x3C4 };
static const symbol s_10_35[3] = { 0x3B1, 0x3C7, 0x3C4 };
static const symbol s_10_36[3] = { 0x3C4, 0x3B1, 0x3C7 };
static const symbol s_10_37[2] = { 0x3C3, 0x3C7 };
static const symbol s_10_38[3] = { 0x3B1, 0x3C3, 0x3C7 };
static const symbol s_10_39[2] = { 0x3C5, 0x3C8 };
static const struct among a_10[40] = {
{ 3, s_10_0, 0, 2, 0},
{ 2, s_10_1, 0, 2, 0},
{ 3, s_10_2, -1, 2, 0},
{ 3, s_10_3, 0, 2, 0},
{ 3, s_10_4, 0, 2, 0},
{ 2, s_10_5, 0, 2, 0},
{ 3, s_10_6, 0, 1, 0},
{ 6, s_10_7, -1, 1, 0},
{ 3, s_10_8, 0, 1, 0},
{ 4, s_10_9, 0, 1, 0},
{ 2, s_10_10, 0, 1, 0},
{ 3, s_10_11, -1, 1, 0},
{ 3, s_10_12, 0, 2, 0},
{ 3, s_10_13, 0, 2, 0},
{ 3, s_10_14, 0, 2, 0},
{ 3, s_10_15, 0, 2, 0},
{ 2, s_10_16, 0, 2, 0},
{ 3, s_10_17, 0, 2, 0},
{ 3, s_10_18, 0, 2, 0},
{ 1, s_10_19, 0, 2, 0},
{ 3, s_10_20, -1, 2, 0},
{ 3, s_10_21, 0, 2, 0},
{ 7, s_10_22, 0, 1, 0},
{ 1, s_10_23, 0, 2, 0},
{ 2, s_10_24, -1, 2, 0},
{ 3, s_10_25, -2, 2, 0},
{ 3, s_10_26, -3, 2, 0},
{ 2, s_10_27, 0, 2, 0},
{ 3, s_10_28, 0, 2, 0},
{ 3, s_10_29, 0, 2, 0},
{ 2, s_10_30, 0, 2, 0},
{ 3, s_10_31, 0, 2, 0},
{ 2, s_10_32, 0, 2, 0},
{ 3, s_10_33, -1, 2, 0},
{ 2, s_10_34, 0, 2, 0},
{ 3, s_10_35, -1, 2, 0},
{ 3, s_10_36, 0, 2, 0},
{ 2, s_10_37, 0, 2, 0},
{ 3, s_10_38, -1, 2, 0},
{ 2, s_10_39, 0, 2, 0}
};

static const symbol s_11_0[4] = { 0x3B9, 0x3C3, 0x3C4, 0x3B1 };
static const symbol s_11_1[4] = { 0x3B9, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_11_2[4] = { 0x3B9, 0x3C3, 0x3C4, 0x3B7 };
static const symbol s_11_3[5] = { 0x3B9, 0x3C3, 0x3C4, 0x3BF, 0x3B9 };
static const symbol s_11_4[5] = { 0x3B9, 0x3C3, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_11_5[4] = { 0x3B9, 0x3C3, 0x3C4, 0x3BF };
static const symbol s_11_6[5] = { 0x3B9, 0x3C3, 0x3C4, 0x3B5, 0x3C3 };
static const symbol s_11_7[5] = { 0x3B9, 0x3C3, 0x3C4, 0x3B7, 0x3C3 };
static const symbol s_11_8[5] = { 0x3B9, 0x3C3, 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_11_9[6] = { 0x3B9, 0x3C3, 0x3C4, 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_11_10[5] = { 0x3B9, 0x3C3, 0x3C4, 0x3BF, 0x3C5 };
static const struct among a_11[11] = {
{ 4, s_11_0, 0, 1, 0},
{ 4, s_11_1, 0, 1, 0},
{ 4, s_11_2, 0, 1, 0},
{ 5, s_11_3, 0, 1, 0},
{ 5, s_11_4, 0, 1, 0},
{ 4, s_11_5, 0, 1, 0},
{ 5, s_11_6, 0, 1, 0},
{ 5, s_11_7, 0, 1, 0},
{ 5, s_11_8, 0, 1, 0},
{ 6, s_11_9, 0, 1, 0},
{ 5, s_11_10, 0, 1, 0}
};

static const symbol s_12_0[5] = { 0x3B5, 0x3B3, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_12_1[6] = { 0x3B1, 0x3C0, 0x3BF, 0x3BA, 0x3BB, 0x3B5 };
static const symbol s_12_2[4] = { 0x3B4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_12_3[8] = { 0x3B1, 0x3BD, 0x3C4, 0x3B9, 0x3B4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_12_4[2] = { 0x3C3, 0x3B5 };
static const symbol s_12_5[6] = { 0x3BC, 0x3B5, 0x3C4, 0x3B1, 0x3C3, 0x3B5 };
static const symbol s_12_6[7] = { 0x3BC, 0x3B9, 0x3BA, 0x3C1, 0x3BF, 0x3C3, 0x3B5 };
static const struct among a_12[7] = {
{ 5, s_12_0, 0, 1, 0},
{ 6, s_12_1, 0, 1, 0},
{ 4, s_12_2, 0, 2, 0},
{ 8, s_12_3, -1, 2, 0},
{ 2, s_12_4, 0, 1, 0},
{ 6, s_12_5, -1, 1, 0},
{ 7, s_12_6, -2, 1, 0}
};

static const symbol s_13_0[6] = { 0x3B1, 0x3C4, 0x3BF, 0x3BC, 0x3B9, 0x3BA };
static const symbol s_13_1[5] = { 0x3B5, 0x3B8, 0x3BD, 0x3B9, 0x3BA };
static const symbol s_13_2[5] = { 0x3C4, 0x3BF, 0x3C0, 0x3B9, 0x3BA };
static const symbol s_13_3[8] = { 0x3B5, 0x3BA, 0x3BB, 0x3B5, 0x3BA, 0x3C4, 0x3B9, 0x3BA };
static const symbol s_13_4[7] = { 0x3C3, 0x3BA, 0x3B5, 0x3C0, 0x3C4, 0x3B9, 0x3BA };
static const symbol s_13_5[7] = { 0x3B3, 0x3BD, 0x3C9, 0x3C3, 0x3C4, 0x3B9, 0x3BA };
static const symbol s_13_6[8] = { 0x3B1, 0x3B3, 0x3BD, 0x3C9, 0x3C3, 0x3C4, 0x3B9, 0x3BA };
static const symbol s_13_7[10] = { 0x3B1, 0x3BB, 0x3B5, 0x3BE, 0x3B1, 0x3BD, 0x3B4, 0x3C1, 0x3B9, 0x3BD };
static const symbol s_13_8[7] = { 0x3B8, 0x3B5, 0x3B1, 0x3C4, 0x3C1, 0x3B9, 0x3BD };
static const symbol s_13_9[8] = { 0x3B2, 0x3C5, 0x3B6, 0x3B1, 0x3BD, 0x3C4, 0x3B9, 0x3BD };
static const struct among a_13[10] = {
{ 6, s_13_0, 0, 2, 0},
{ 5, s_13_1, 0, 4, 0},
{ 5, s_13_2, 0, 7, 0},
{ 8, s_13_3, 0, 5, 0},
{ 7, s_13_4, 0, 6, 0},
{ 7, s_13_5, 0, 3, 0},
{ 8, s_13_6, -1, 1, 0},
{ 10, s_13_7, 0, 8, 0},
{ 7, s_13_8, 0, 10, 0},
{ 8, s_13_9, 0, 9, 0}
};

static const symbol s_14_0[5] = { 0x3B9, 0x3C3, 0x3BC, 0x3BF, 0x3B9 };
static const symbol s_14_1[5] = { 0x3B9, 0x3C3, 0x3BC, 0x3C9, 0x3BD };
static const symbol s_14_2[4] = { 0x3B9, 0x3C3, 0x3BC, 0x3BF };
static const symbol s_14_3[5] = { 0x3B9, 0x3C3, 0x3BC, 0x3BF, 0x3C3 };
static const symbol s_14_4[6] = { 0x3B9, 0x3C3, 0x3BC, 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_14_5[5] = { 0x3B9, 0x3C3, 0x3BC, 0x3BF, 0x3C5 };
static const struct among a_14[6] = {
{ 5, s_14_0, 0, 1, 0},
{ 5, s_14_1, 0, 1, 0},
{ 4, s_14_2, 0, 1, 0},
{ 5, s_14_3, 0, 1, 0},
{ 6, s_14_4, 0, 1, 0},
{ 5, s_14_5, 0, 1, 0}
};

static const symbol s_16_0[7] = { 0x3BF, 0x3C5, 0x3B4, 0x3B1, 0x3BA, 0x3B9, 0x3B1 };
static const symbol s_16_1[6] = { 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B9, 0x3B1 };
static const symbol s_16_2[6] = { 0x3BF, 0x3C5, 0x3B4, 0x3B1, 0x3BA, 0x3B9 };
static const symbol s_16_3[5] = { 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B9 };
static const struct among a_16[4] = {
{ 7, s_16_0, 0, 1, 0},
{ 6, s_16_1, 0, 1, 0},
{ 6, s_16_2, 0, 1, 0},
{ 5, s_16_3, 0, 1, 0}
};

static const symbol s_17_0[1] = { 0x3B2 };
static const symbol s_17_1[4] = { 0x3B2, 0x3B1, 0x3BC, 0x3B2 };
static const symbol s_17_2[4] = { 0x3C3, 0x3BB, 0x3BF, 0x3B2 };
static const symbol s_17_3[9] = { 0x3C4, 0x3C3, 0x3B5, 0x3C7, 0x3BF, 0x3C3, 0x3BB, 0x3BF, 0x3B2 };
static const symbol s_17_4[4] = { 0x3BA, 0x3B1, 0x3C1, 0x3B4 };
static const symbol s_17_5[1] = { 0x3B6 };
static const symbol s_17_6[2] = { 0x3C4, 0x3B6 };
static const symbol s_17_7[1] = { 0x3BA };
static const symbol s_17_8[5] = { 0x3BA, 0x3B1, 0x3C0, 0x3B1, 0x3BA };
static const symbol s_17_9[3] = { 0x3C3, 0x3BF, 0x3BA };
static const symbol s_17_10[2] = { 0x3C3, 0x3BA };
static const symbol s_17_11[3] = { 0x3B2, 0x3B1, 0x3BB };
static const symbol s_17_12[3] = { 0x3BC, 0x3B1, 0x3BB };
static const symbol s_17_13[2] = { 0x3B3, 0x3BB };
static const symbol s_17_14[6] = { 0x3C4, 0x3C1, 0x3B9, 0x3C0, 0x3BF, 0x3BB };
static const symbol s_17_15[2] = { 0x3C0, 0x3BB };
static const symbol s_17_16[4] = { 0x3BB, 0x3BF, 0x3C5, 0x3BB };
static const symbol s_17_17[3] = { 0x3C6, 0x3C5, 0x3BB };
static const symbol s_17_18[4] = { 0x3BA, 0x3B1, 0x3B9, 0x3BC };
static const symbol s_17_19[4] = { 0x3BA, 0x3BB, 0x3B9, 0x3BC };
static const symbol s_17_20[4] = { 0x3C6, 0x3B1, 0x3C1, 0x3BC };
static const symbol s_17_21[4] = { 0x3B3, 0x3B9, 0x3B1, 0x3BD };
static const symbol s_17_22[4] = { 0x3C3, 0x3C0, 0x3B1, 0x3BD };
static const symbol s_17_23[7] = { 0x3B7, 0x3B3, 0x3BF, 0x3C5, 0x3BC, 0x3B5, 0x3BD };
static const symbol s_17_24[3] = { 0x3BA, 0x3BF, 0x3BD };
static const symbol s_17_25[6] = { 0x3BC, 0x3B1, 0x3BA, 0x3C1, 0x3C5, 0x3BD };
static const symbol s_17_26[1] = { 0x3C0 };
static const symbol s_17_27[6] = { 0x3BA, 0x3B1, 0x3C4, 0x3C1, 0x3B1, 0x3C0 };
static const symbol s_17_28[1] = { 0x3C1 };
static const symbol s_17_29[2] = { 0x3B2, 0x3C1 };
static const symbol s_17_30[4] = { 0x3BB, 0x3B1, 0x3B2, 0x3C1 };
static const symbol s_17_31[4] = { 0x3B1, 0x3BC, 0x3B2, 0x3C1 };
static const symbol s_17_32[3] = { 0x3BC, 0x3B5, 0x3C1 };
static const symbol s_17_33[5] = { 0x3C0, 0x3B1, 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_17_34[4] = { 0x3B1, 0x3BD, 0x3B8, 0x3C1 };
static const symbol s_17_35[3] = { 0x3BA, 0x3BF, 0x3C1 };
static const symbol s_17_36[1] = { 0x3C3 };
static const symbol s_17_37[6] = { 0x3BD, 0x3B1, 0x3B3, 0x3BA, 0x3B1, 0x3C3 };
static const symbol s_17_38[3] = { 0x3C4, 0x3BF, 0x3C3 };
static const symbol s_17_39[5] = { 0x3BC, 0x3BF, 0x3C5, 0x3C3, 0x3C4 };
static const symbol s_17_40[2] = { 0x3C1, 0x3C5 };
static const symbol s_17_41[1] = { 0x3C6 };
static const symbol s_17_42[2] = { 0x3C3, 0x3C6 };
static const symbol s_17_43[5] = { 0x3B1, 0x3BB, 0x3B9, 0x3C3, 0x3C6 };
static const symbol s_17_44[3] = { 0x3BD, 0x3C5, 0x3C6 };
static const symbol s_17_45[1] = { 0x3C7 };
static const struct among a_17[46] = {
{ 1, s_17_0, 0, 2, 0},
{ 4, s_17_1, -1, 1, 0},
{ 4, s_17_2, -2, 1, 0},
{ 9, s_17_3, -1, 1, 0},
{ 4, s_17_4, 0, 2, 0},
{ 1, s_17_5, 0, 2, 0},
{ 2, s_17_6, -1, 1, 0},
{ 1, s_17_7, 0, 1, 0},
{ 5, s_17_8, -1, 1, 0},
{ 3, s_17_9, -2, 1, 0},
{ 2, s_17_10, -3, 1, 0},
{ 3, s_17_11, 0, 2, 0},
{ 3, s_17_12, 0, 1, 0},
{ 2, s_17_13, 0, 2, 0},
{ 6, s_17_14, 0, 2, 0},
{ 2, s_17_15, 0, 1, 0},
{ 4, s_17_16, 0, 1, 0},
{ 3, s_17_17, 0, 1, 0},
{ 4, s_17_18, 0, 1, 0},
{ 4, s_17_19, 0, 1, 0},
{ 4, s_17_20, 0, 1, 0},
{ 4, s_17_21, 0, 2, 0},
{ 4, s_17_22, 0, 1, 0},
{ 7, s_17_23, 0, 2, 0},
{ 3, s_17_24, 0, 1, 0},
{ 6, s_17_25, 0, 2, 0},
{ 1, s_17_26, 0, 2, 0},
{ 6, s_17_27, -1, 1, 0},
{ 1, s_17_28, 0, 1, 0},
{ 2, s_17_29, -1, 1, 0},
{ 4, s_17_30, -1, 1, 0},
{ 4, s_17_31, -2, 1, 0},
{ 3, s_17_32, -4, 1, 0},
{ 5, s_17_33, -5, 2, 0},
{ 4, s_17_34, -6, 1, 0},
{ 3, s_17_35, -7, 1, 0},
{ 1, s_17_36, 0, 1, 0},
{ 6, s_17_37, -1, 1, 0},
{ 3, s_17_38, -2, 2, 0},
{ 5, s_17_39, 0, 1, 0},
{ 2, s_17_40, 0, 1, 0},
{ 1, s_17_41, 0, 1, 0},
{ 2, s_17_42, -1, 1, 0},
{ 5, s_17_43, -1, 1, 0},
{ 3, s_17_44, -3, 2, 0},
{ 1, s_17_45, 0, 1, 0}
};

static const symbol s_18_0[4] = { 0x3B1, 0x3BA, 0x3B9, 0x3B1 };
static const symbol s_18_1[6] = { 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B9, 0x3B1 };
static const symbol s_18_2[4] = { 0x3B9, 0x3C4, 0x3C3, 0x3B1 };
static const symbol s_18_3[3] = { 0x3B1, 0x3BA, 0x3B9 };
static const symbol s_18_4[5] = { 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B9 };
static const symbol s_18_5[5] = { 0x3B9, 0x3C4, 0x3C3, 0x3C9, 0x3BD };
static const symbol s_18_6[5] = { 0x3B9, 0x3C4, 0x3C3, 0x3B1, 0x3C3 };
static const symbol s_18_7[5] = { 0x3B9, 0x3C4, 0x3C3, 0x3B5, 0x3C3 };
static const struct among a_18[8] = {
{ 4, s_18_0, 0, 1, 0},
{ 6, s_18_1, -1, 1, 0},
{ 4, s_18_2, 0, 1, 0},
{ 3, s_18_3, 0, 1, 0},
{ 5, s_18_4, -1, 1, 0},
{ 5, s_18_5, 0, 1, 0},
{ 5, s_18_6, 0, 1, 0},
{ 5, s_18_7, 0, 1, 0}
};

static const symbol s_19_0[3] = { 0x3C8, 0x3B1, 0x3BB };
static const symbol s_19_1[4] = { 0x3B1, 0x3B9, 0x3C6, 0x3BD };
static const symbol s_19_2[3] = { 0x3BF, 0x3BB, 0x3BF };
static const symbol s_19_3[2] = { 0x3B9, 0x3C1 };
static const struct among a_19[4] = {
{ 3, s_19_0, 0, 1, 0},
{ 4, s_19_1, 0, 1, 0},
{ 3, s_19_2, 0, 1, 0},
{ 2, s_19_3, 0, 1, 0}
};

static const symbol s_20_0[1] = { 0x3B5 };
static const symbol s_20_1[5] = { 0x3C0, 0x3B1, 0x3B9, 0x3C7, 0x3BD };
static const struct among a_20[2] = {
{ 1, s_20_0, 0, 1, 0},
{ 5, s_20_1, 0, 1, 0}
};

static const symbol s_21_0[4] = { 0x3B9, 0x3B4, 0x3B9, 0x3B1 };
static const symbol s_21_1[5] = { 0x3B9, 0x3B4, 0x3B9, 0x3C9, 0x3BD };
static const symbol s_21_2[4] = { 0x3B9, 0x3B4, 0x3B9, 0x3BF };
static const struct among a_21[3] = {
{ 4, s_21_0, 0, 1, 0},
{ 5, s_21_1, 0, 1, 0},
{ 4, s_21_2, 0, 1, 0}
};

static const symbol s_22_0[2] = { 0x3B9, 0x3B2 };
static const symbol s_22_1[1] = { 0x3B4 };
static const symbol s_22_2[5] = { 0x3C6, 0x3C1, 0x3B1, 0x3B3, 0x3BA };
static const symbol s_22_3[3] = { 0x3BB, 0x3C5, 0x3BA };
static const symbol s_22_4[4] = { 0x3BF, 0x3B2, 0x3B5, 0x3BB };
static const symbol s_22_5[3] = { 0x3BC, 0x3B7, 0x3BD };
static const symbol s_22_6[1] = { 0x3C1 };
static const struct among a_22[7] = {
{ 2, s_22_0, 0, 1, 0},
{ 1, s_22_1, 0, 1, 0},
{ 5, s_22_2, 0, 1, 0},
{ 3, s_22_3, 0, 1, 0},
{ 4, s_22_4, 0, 1, 0},
{ 3, s_22_5, 0, 1, 0},
{ 1, s_22_6, 0, 1, 0}
};

static const symbol s_23_0[4] = { 0x3B9, 0x3C3, 0x3BA, 0x3B5 };
static const symbol s_23_1[4] = { 0x3B9, 0x3C3, 0x3BA, 0x3BF };
static const symbol s_23_2[5] = { 0x3B9, 0x3C3, 0x3BA, 0x3BF, 0x3C3 };
static const symbol s_23_3[5] = { 0x3B9, 0x3C3, 0x3BA, 0x3BF, 0x3C5 };
static const struct among a_23[4] = {
{ 4, s_23_0, 0, 1, 0},
{ 4, s_23_1, 0, 1, 0},
{ 5, s_23_2, 0, 1, 0},
{ 5, s_23_3, 0, 1, 0}
};

static const symbol s_24_0[4] = { 0x3B1, 0x3B4, 0x3C9, 0x3BD };
static const symbol s_24_1[4] = { 0x3B1, 0x3B4, 0x3B5, 0x3C3 };
static const struct among a_24[2] = {
{ 4, s_24_0, 0, 1, 0},
{ 4, s_24_1, 0, 1, 0}
};

static const symbol s_25_0[5] = { 0x3B3, 0x3B9, 0x3B1, 0x3B3, 0x3B9 };
static const symbol s_25_1[3] = { 0x3B8, 0x3B5, 0x3B9 };
static const symbol s_25_2[2] = { 0x3BF, 0x3BA };
static const symbol s_25_3[3] = { 0x3BC, 0x3B1, 0x3BC };
static const symbol s_25_4[3] = { 0x3BC, 0x3B1, 0x3BD };
static const symbol s_25_5[5] = { 0x3BC, 0x3C0, 0x3B1, 0x3BC, 0x3C0 };
static const symbol s_25_6[5] = { 0x3C0, 0x3B5, 0x3B8, 0x3B5, 0x3C1 };
static const symbol s_25_7[5] = { 0x3C0, 0x3B1, 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_25_8[3] = { 0x3BA, 0x3C5, 0x3C1 };
static const symbol s_25_9[5] = { 0x3BD, 0x3C4, 0x3B1, 0x3BD, 0x3C4 };
static const struct among a_25[10] = {
{ 5, s_25_0, 0, -1, 0},
{ 3, s_25_1, 0, -1, 0},
{ 2, s_25_2, 0, -1, 0},
{ 3, s_25_3, 0, -1, 0},
{ 3, s_25_4, 0, -1, 0},
{ 5, s_25_5, 0, -1, 0},
{ 5, s_25_6, 0, -1, 0},
{ 5, s_25_7, 0, -1, 0},
{ 3, s_25_8, 0, -1, 0},
{ 5, s_25_9, 0, -1, 0}
};

static const symbol s_26_0[4] = { 0x3B5, 0x3B4, 0x3C9, 0x3BD };
static const symbol s_26_1[4] = { 0x3B5, 0x3B4, 0x3B5, 0x3C3 };
static const struct among a_26[2] = {
{ 4, s_26_0, 0, 1, 0},
{ 4, s_26_1, 0, 1, 0}
};

static const symbol s_27_0[3] = { 0x3BC, 0x3B9, 0x3BB };
static const symbol s_27_1[3] = { 0x3B4, 0x3B1, 0x3C0 };
static const symbol s_27_2[3] = { 0x3B3, 0x3B7, 0x3C0 };
static const symbol s_27_3[2] = { 0x3B9, 0x3C0 };
static const symbol s_27_4[3] = { 0x3B5, 0x3BC, 0x3C0 };
static const symbol s_27_5[2] = { 0x3BF, 0x3C0 };
static const symbol s_27_6[5] = { 0x3BA, 0x3C1, 0x3B1, 0x3C3, 0x3C0 };
static const symbol s_27_7[2] = { 0x3C5, 0x3C0 };
static const struct among a_27[8] = {
{ 3, s_27_0, 0, 1, 0},
{ 3, s_27_1, 0, 1, 0},
{ 3, s_27_2, 0, 1, 0},
{ 2, s_27_3, 0, 1, 0},
{ 3, s_27_4, 0, 1, 0},
{ 2, s_27_5, 0, 1, 0},
{ 5, s_27_6, 0, 1, 0},
{ 2, s_27_7, 0, 1, 0}
};

static const symbol s_28_0[5] = { 0x3BF, 0x3C5, 0x3B4, 0x3C9, 0x3BD };
static const symbol s_28_1[5] = { 0x3BF, 0x3C5, 0x3B4, 0x3B5, 0x3C3 };
static const struct among a_28[2] = {
{ 5, s_28_0, 0, 1, 0},
{ 5, s_28_1, 0, 1, 0}
};

static const symbol s_29_0[4] = { 0x3C4, 0x3C1, 0x3B1, 0x3B3 };
static const symbol s_29_1[2] = { 0x3C6, 0x3B5 };
static const symbol s_29_2[6] = { 0x3BA, 0x3B1, 0x3BB, 0x3B9, 0x3B1, 0x3BA };
static const symbol s_29_3[3] = { 0x3B1, 0x3C1, 0x3BA };
static const symbol s_29_4[2] = { 0x3C3, 0x3BA };
static const symbol s_29_5[5] = { 0x3C0, 0x3B5, 0x3C4, 0x3B1, 0x3BB };
static const symbol s_29_6[3] = { 0x3B2, 0x3B5, 0x3BB };
static const symbol s_29_7[4] = { 0x3BB, 0x3BF, 0x3C5, 0x3BB };
static const symbol s_29_8[2] = { 0x3C6, 0x3BB };
static const symbol s_29_9[2] = { 0x3C7, 0x3BD };
static const symbol s_29_10[4] = { 0x3C0, 0x3BB, 0x3B5, 0x3BE };
static const symbol s_29_11[2] = { 0x3C3, 0x3C0 };
static const symbol s_29_12[2] = { 0x3C6, 0x3C1 };
static const symbol s_29_13[1] = { 0x3C3 };
static const symbol s_29_14[3] = { 0x3BB, 0x3B9, 0x3C7 };
static const struct among a_29[15] = {
{ 4, s_29_0, 0, 1, 0},
{ 2, s_29_1, 0, 1, 0},
{ 6, s_29_2, 0, 1, 0},
{ 3, s_29_3, 0, 1, 0},
{ 2, s_29_4, 0, 1, 0},
{ 5, s_29_5, 0, 1, 0},
{ 3, s_29_6, 0, 1, 0},
{ 4, s_29_7, 0, 1, 0},
{ 2, s_29_8, 0, 1, 0},
{ 2, s_29_9, 0, 1, 0},
{ 4, s_29_10, 0, 1, 0},
{ 2, s_29_11, 0, 1, 0},
{ 2, s_29_12, 0, 1, 0},
{ 1, s_29_13, 0, 1, 0},
{ 3, s_29_14, 0, 1, 0}
};

static const symbol s_30_0[3] = { 0x3B5, 0x3C9, 0x3BD };
static const symbol s_30_1[3] = { 0x3B5, 0x3C9, 0x3C3 };
static const struct among a_30[2] = {
{ 3, s_30_0, 0, 1, 0},
{ 3, s_30_1, 0, 1, 0}
};

static const symbol s_31_0[1] = { 0x3B4 };
static const symbol s_31_1[2] = { 0x3B9, 0x3B4 };
static const symbol s_31_2[1] = { 0x3B8 };
static const symbol s_31_3[3] = { 0x3B3, 0x3B1, 0x3BB };
static const symbol s_31_4[2] = { 0x3B5, 0x3BB };
static const symbol s_31_5[1] = { 0x3BD };
static const symbol s_31_6[1] = { 0x3C0 };
static const symbol s_31_7[3] = { 0x3C0, 0x3B1, 0x3C1 };
static const struct among a_31[8] = {
{ 1, s_31_0, 0, 1, 0},
{ 2, s_31_1, -1, 1, 0},
{ 1, s_31_2, 0, 1, 0},
{ 3, s_31_3, 0, 1, 0},
{ 2, s_31_4, 0, 1, 0},
{ 1, s_31_5, 0, 1, 0},
{ 1, s_31_6, 0, 1, 0},
{ 3, s_31_7, 0, 1, 0}
};

static const symbol s_32_0[2] = { 0x3B9, 0x3B1 };
static const symbol s_32_1[3] = { 0x3B9, 0x3C9, 0x3BD };
static const symbol s_32_2[3] = { 0x3B9, 0x3BF, 0x3C5 };
static const struct among a_32[3] = {
{ 2, s_32_0, 0, 1, 0},
{ 3, s_32_1, 0, 1, 0},
{ 3, s_32_2, 0, 1, 0}
};

static const symbol s_33_0[3] = { 0x3B9, 0x3BA, 0x3B1 };
static const symbol s_33_1[4] = { 0x3B9, 0x3BA, 0x3C9, 0x3BD };
static const symbol s_33_2[3] = { 0x3B9, 0x3BA, 0x3BF };
static const symbol s_33_3[4] = { 0x3B9, 0x3BA, 0x3BF, 0x3C5 };
static const struct among a_33[4] = {
{ 3, s_33_0, 0, 1, 0},
{ 4, s_33_1, 0, 1, 0},
{ 3, s_33_2, 0, 1, 0},
{ 4, s_33_3, 0, 1, 0}
};

static const symbol s_34_0[2] = { 0x3B1, 0x3B4 };
static const symbol s_34_1[5] = { 0x3C3, 0x3C5, 0x3BD, 0x3B1, 0x3B4 };
static const symbol s_34_2[5] = { 0x3BA, 0x3B1, 0x3C4, 0x3B1, 0x3B4 };
static const symbol s_34_3[5] = { 0x3B1, 0x3BD, 0x3C4, 0x3B9, 0x3B4 };
static const symbol s_34_4[3] = { 0x3B5, 0x3BD, 0x3B4 };
static const symbol s_34_5[5] = { 0x3C6, 0x3C5, 0x3BB, 0x3BF, 0x3B4 };
static const symbol s_34_6[4] = { 0x3C5, 0x3C0, 0x3BF, 0x3B4 };
static const symbol s_34_7[6] = { 0x3C0, 0x3C1, 0x3C9, 0x3C4, 0x3BF, 0x3B4 };
static const symbol s_34_8[4] = { 0x3B5, 0x3BE, 0x3C9, 0x3B4 };
static const symbol s_34_9[2] = { 0x3B7, 0x3B8 };
static const symbol s_34_10[4] = { 0x3B1, 0x3BD, 0x3B7, 0x3B8 };
static const symbol s_34_11[3] = { 0x3BE, 0x3B9, 0x3BA };
static const symbol s_34_12[2] = { 0x3B1, 0x3BB };
static const symbol s_34_13[7] = { 0x3B1, 0x3BC, 0x3BC, 0x3BF, 0x3C7, 0x3B1, 0x3BB };
static const symbol s_34_14[7] = { 0x3C3, 0x3C5, 0x3BD, 0x3BF, 0x3BC, 0x3B7, 0x3BB };
static const symbol s_34_15[4] = { 0x3BC, 0x3C0, 0x3BF, 0x3BB };
static const symbol s_34_16[4] = { 0x3BC, 0x3BF, 0x3C5, 0x3BB };
static const symbol s_34_17[4] = { 0x3C4, 0x3C3, 0x3B1, 0x3BC };
static const symbol s_34_18[4] = { 0x3B2, 0x3C1, 0x3C9, 0x3BC };
static const symbol s_34_19[4] = { 0x3B1, 0x3BC, 0x3B1, 0x3BD };
static const symbol s_34_20[4] = { 0x3BC, 0x3C0, 0x3B1, 0x3BD };
static const symbol s_34_21[6] = { 0x3BA, 0x3B1, 0x3BB, 0x3BB, 0x3B9, 0x3BD };
static const symbol s_34_22[7] = { 0x3C0, 0x3BF, 0x3C3, 0x3C4, 0x3B5, 0x3BB, 0x3BD };
static const symbol s_34_23[5] = { 0x3C6, 0x3B9, 0x3BB, 0x3BF, 0x3BD };
static const symbol s_34_24[4] = { 0x3BA, 0x3B1, 0x3BB, 0x3C0 };
static const symbol s_34_25[3] = { 0x3B3, 0x3B5, 0x3C1 };
static const symbol s_34_26[3] = { 0x3C7, 0x3B1, 0x3C3 };
static const symbol s_34_27[4] = { 0x3BC, 0x3C0, 0x3BF, 0x3C3 };
static const symbol s_34_28[6] = { 0x3C0, 0x3BB, 0x3B9, 0x3B1, 0x3C4, 0x3C3 };
static const symbol s_34_29[4] = { 0x3C0, 0x3B5, 0x3C4, 0x3C3 };
static const symbol s_34_30[4] = { 0x3C0, 0x3B9, 0x3C4, 0x3C3 };
static const symbol s_34_31[3] = { 0x3C6, 0x3C5, 0x3C3 };
static const symbol s_34_32[7] = { 0x3BC, 0x3C0, 0x3B1, 0x3B3, 0x3B9, 0x3B1, 0x3C4 };
static const symbol s_34_33[3] = { 0x3BD, 0x3B9, 0x3C4 };
static const symbol s_34_34[6] = { 0x3C0, 0x3B9, 0x3BA, 0x3B1, 0x3BD, 0x3C4 };
static const symbol s_34_35[4] = { 0x3C3, 0x3B5, 0x3C1, 0x3C4 };
static const struct among a_34[36] = {
{ 2, s_34_0, 0, 1, 0},
{ 5, s_34_1, -1, 1, 0},
{ 5, s_34_2, -2, 1, 0},
{ 5, s_34_3, 0, 1, 0},
{ 3, s_34_4, 0, 1, 0},
{ 5, s_34_5, 0, 1, 0},
{ 4, s_34_6, 0, 1, 0},
{ 6, s_34_7, 0, 1, 0},
{ 4, s_34_8, 0, 1, 0},
{ 2, s_34_9, 0, 1, 0},
{ 4, s_34_10, -1, 1, 0},
{ 3, s_34_11, 0, 1, 0},
{ 2, s_34_12, 0, 1, 0},
{ 7, s_34_13, -1, 1, 0},
{ 7, s_34_14, 0, 1, 0},
{ 4, s_34_15, 0, 1, 0},
{ 4, s_34_16, 0, 1, 0},
{ 4, s_34_17, 0, 1, 0},
{ 4, s_34_18, 0, 1, 0},
{ 4, s_34_19, 0, 1, 0},
{ 4, s_34_20, 0, 1, 0},
{ 6, s_34_21, 0, 1, 0},
{ 7, s_34_22, 0, 1, 0},
{ 5, s_34_23, 0, 1, 0},
{ 4, s_34_24, 0, 1, 0},
{ 3, s_34_25, 0, 1, 0},
{ 3, s_34_26, 0, 1, 0},
{ 4, s_34_27, 0, 1, 0},
{ 6, s_34_28, 0, 1, 0},
{ 4, s_34_29, 0, 1, 0},
{ 4, s_34_30, 0, 1, 0},
{ 3, s_34_31, 0, 1, 0},
{ 7, s_34_32, 0, 1, 0},
{ 3, s_34_33, 0, 1, 0},
{ 6, s_34_34, 0, 1, 0},
{ 4, s_34_35, 0, 1, 0}
};

static const symbol s_35_0[5] = { 0x3B1, 0x3B3, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_35_1[5] = { 0x3B7, 0x3BA, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_35_2[7] = { 0x3B7, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_35_3[5] = { 0x3B7, 0x3C3, 0x3B1, 0x3BC, 0x3B5 };
static const symbol s_35_4[6] = { 0x3BF, 0x3C5, 0x3C3, 0x3B1, 0x3BC, 0x3B5 };
static const struct among a_35[5] = {
{ 5, s_35_0, 0, 1, 0},
{ 5, s_35_1, 0, 1, 0},
{ 7, s_35_2, -1, 1, 0},
{ 5, s_35_3, 0, 1, 0},
{ 6, s_35_4, 0, 1, 0}
};

static const symbol s_36_0[4] = { 0x3B2, 0x3BF, 0x3C5, 0x3B2 };
static const symbol s_36_1[3] = { 0x3BE, 0x3B5, 0x3B8 };
static const symbol s_36_2[3] = { 0x3C0, 0x3B5, 0x3B8 };
static const symbol s_36_3[4] = { 0x3B1, 0x3C0, 0x3BF, 0x3B8 };
static const symbol s_36_4[4] = { 0x3B1, 0x3C0, 0x3BF, 0x3BA };
static const symbol s_36_5[3] = { 0x3BF, 0x3C5, 0x3BB };
static const symbol s_36_6[4] = { 0x3B1, 0x3BD, 0x3B1, 0x3C0 };
static const symbol s_36_7[4] = { 0x3C0, 0x3B9, 0x3BA, 0x3C1 };
static const symbol s_36_8[3] = { 0x3C0, 0x3BF, 0x3C4 };
static const symbol s_36_9[5] = { 0x3B1, 0x3C0, 0x3BF, 0x3C3, 0x3C4 };
static const symbol s_36_10[1] = { 0x3C7 };
static const symbol s_36_11[3] = { 0x3C3, 0x3B9, 0x3C7 };
static const struct among a_36[12] = {
{ 4, s_36_0, 0, 1, 0},
{ 3, s_36_1, 0, 1, 0},
{ 3, s_36_2, 0, 1, 0},
{ 4, s_36_3, 0, 1, 0},
{ 4, s_36_4, 0, 1, 0},
{ 3, s_36_5, 0, 1, 0},
{ 4, s_36_6, 0, 1, 0},
{ 4, s_36_7, 0, 1, 0},
{ 3, s_36_8, 0, 1, 0},
{ 5, s_36_9, 0, 1, 0},
{ 1, s_36_10, 0, 1, 0},
{ 3, s_36_11, -1, 1, 0}
};

static const symbol s_37_0[2] = { 0x3C4, 0x3C1 };
static const symbol s_37_1[2] = { 0x3C4, 0x3C3 };
static const struct among a_37[2] = {
{ 2, s_37_0, 0, 1, 0},
{ 2, s_37_1, 0, 1, 0}
};

static const symbol s_38_0[5] = { 0x3B1, 0x3B3, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_1[5] = { 0x3B7, 0x3BA, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_2[7] = { 0x3B7, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_3[5] = { 0x3B7, 0x3C3, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_4[6] = { 0x3BF, 0x3C5, 0x3C3, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_5[6] = { 0x3BF, 0x3BD, 0x3C4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_6[7] = { 0x3B9, 0x3BF, 0x3BD, 0x3C4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_7[7] = { 0x3BF, 0x3C5, 0x3BD, 0x3C4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_8[8] = { 0x3B9, 0x3BF, 0x3C5, 0x3BD, 0x3C4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_9[5] = { 0x3BF, 0x3C4, 0x3B1, 0x3BD, 0x3B5 };
static const symbol s_38_10[6] = { 0x3B9, 0x3BF, 0x3C4, 0x3B1, 0x3BD, 0x3B5 };
static const struct among a_38[11] = {
{ 5, s_38_0, 0, 1, 0},
{ 5, s_38_1, 0, 1, 0},
{ 7, s_38_2, -1, 1, 0},
{ 5, s_38_3, 0, 1, 0},
{ 6, s_38_4, 0, 1, 0},
{ 6, s_38_5, 0, 1, 0},
{ 7, s_38_6, -1, 1, 0},
{ 7, s_38_7, 0, 1, 0},
{ 8, s_38_8, -1, 1, 0},
{ 5, s_38_9, 0, 1, 0},
{ 6, s_38_10, -1, 1, 0}
};

static const symbol s_39_0[3] = { 0x3C4, 0x3B1, 0x3B2 };
static const symbol s_39_1[4] = { 0x3BD, 0x3C4, 0x3B1, 0x3B2 };
static const symbol s_39_2[7] = { 0x3C8, 0x3B7, 0x3BB, 0x3BF, 0x3C4, 0x3B1, 0x3B2 };
static const symbol s_39_3[3] = { 0x3BB, 0x3B9, 0x3B2 };
static const symbol s_39_4[4] = { 0x3BA, 0x3BB, 0x3B9, 0x3B2 };
static const symbol s_39_5[8] = { 0x3BE, 0x3B7, 0x3C1, 0x3BF, 0x3BA, 0x3BB, 0x3B9, 0x3B2 };
static const symbol s_39_6[1] = { 0x3B3 };
static const symbol s_39_7[2] = { 0x3B1, 0x3B3 };
static const symbol s_39_8[4] = { 0x3C4, 0x3C1, 0x3B1, 0x3B3 };
static const symbol s_39_9[4] = { 0x3C4, 0x3C3, 0x3B1, 0x3B3 };
static const symbol s_39_10[5] = { 0x3B1, 0x3B8, 0x3B9, 0x3B3, 0x3B3 };
static const symbol s_39_11[5] = { 0x3C4, 0x3C3, 0x3B9, 0x3B3, 0x3B3 };
static const symbol s_39_12[6] = { 0x3B1, 0x3C4, 0x3C3, 0x3B9, 0x3B3, 0x3B3 };
static const symbol s_39_13[4] = { 0x3C3, 0x3C4, 0x3B5, 0x3B3 };
static const symbol s_39_14[4] = { 0x3B1, 0x3C0, 0x3B7, 0x3B3 };
static const symbol s_39_15[3] = { 0x3C3, 0x3B9, 0x3B3 };
static const symbol s_39_16[5] = { 0x3B1, 0x3BD, 0x3BF, 0x3C1, 0x3B3 };
static const symbol s_39_17[5] = { 0x3B5, 0x3BD, 0x3BF, 0x3C1, 0x3B3 };
static const symbol s_39_18[7] = { 0x3BA, 0x3B1, 0x3BB, 0x3C0, 0x3BF, 0x3C5, 0x3B6 };
static const symbol s_39_19[1] = { 0x3B8 };
static const symbol s_39_20[6] = { 0x3BC, 0x3C9, 0x3B1, 0x3BC, 0x3B5, 0x3B8 };
static const symbol s_39_21[3] = { 0x3C0, 0x3B9, 0x3B8 };
static const symbol s_39_22[4] = { 0x3B1, 0x3C0, 0x3B9, 0x3B8 };
static const symbol s_39_23[3] = { 0x3B4, 0x3B5, 0x3BA };
static const symbol s_39_24[5] = { 0x3C0, 0x3B5, 0x3BB, 0x3B5, 0x3BA };
static const symbol s_39_25[2] = { 0x3B9, 0x3BA };
static const symbol s_39_26[4] = { 0x3B1, 0x3BD, 0x3B9, 0x3BA };
static const symbol s_39_27[5] = { 0x3B2, 0x3BF, 0x3C5, 0x3BB, 0x3BA };
static const symbol s_39_28[4] = { 0x3B2, 0x3B1, 0x3C3, 0x3BA };
static const symbol s_39_29[6] = { 0x3B2, 0x3C1, 0x3B1, 0x3C7, 0x3C5, 0x3BA };
static const symbol s_39_30[3] = { 0x3B3, 0x3B1, 0x3BB };
static const symbol s_39_31[7] = { 0x3BA, 0x3B1, 0x3C4, 0x3B1, 0x3B3, 0x3B1, 0x3BB };
static const symbol s_39_32[6] = { 0x3BF, 0x3BB, 0x3BF, 0x3B3, 0x3B1, 0x3BB };
static const symbol s_39_33[7] = { 0x3B2, 0x3B1, 0x3B8, 0x3C5, 0x3B3, 0x3B1, 0x3BB };
static const symbol s_39_34[3] = { 0x3BC, 0x3B5, 0x3BB };
static const symbol s_39_35[6] = { 0x3BA, 0x3B1, 0x3C3, 0x3C4, 0x3B5, 0x3BB };
static const symbol s_39_36[6] = { 0x3C0, 0x3BF, 0x3C1, 0x3C4, 0x3BF, 0x3BB };
static const symbol s_39_37[2] = { 0x3C0, 0x3BB };
static const symbol s_39_38[4] = { 0x3B4, 0x3B9, 0x3C0, 0x3BB };
static const symbol s_39_39[5] = { 0x3BB, 0x3B1, 0x3BF, 0x3C0, 0x3BB };
static const symbol s_39_40[6] = { 0x3C8, 0x3C5, 0x3C7, 0x3BF, 0x3C0, 0x3BB };
static const symbol s_39_41[3] = { 0x3BF, 0x3C5, 0x3BB };
static const symbol s_39_42[1] = { 0x3BC };
static const symbol s_39_43[8] = { 0x3BF, 0x3BB, 0x3B9, 0x3B3, 0x3BF, 0x3B4, 0x3B1, 0x3BC };
static const symbol s_39_44[8] = { 0x3BC, 0x3BF, 0x3C5, 0x3C3, 0x3BF, 0x3C5, 0x3BB, 0x3BC };
static const symbol s_39_45[7] = { 0x3B4, 0x3C1, 0x3B1, 0x3B4, 0x3BF, 0x3C5, 0x3BC };
static const symbol s_39_46[5] = { 0x3B2, 0x3C1, 0x3B1, 0x3C7, 0x3BC };
static const symbol s_39_47[1] = { 0x3BD };
static const symbol s_39_48[8] = { 0x3B1, 0x3BC, 0x3B5, 0x3C1, 0x3B9, 0x3BA, 0x3B1, 0x3BD };
static const symbol s_39_49[1] = { 0x3C0 };
static const symbol s_39_50[4] = { 0x3B1, 0x3B4, 0x3B1, 0x3C0 };
static const symbol s_39_51[9] = { 0x3C7, 0x3B1, 0x3BC, 0x3B7, 0x3BB, 0x3BF, 0x3B4, 0x3B1, 0x3C0 };
static const symbol s_39_52[7] = { 0x3C0, 0x3BF, 0x3BB, 0x3C5, 0x3B4, 0x3B1, 0x3C0 };
static const symbol s_39_53[3] = { 0x3BA, 0x3BF, 0x3C0 };
static const symbol s_39_54[6] = { 0x3C5, 0x3C0, 0x3BF, 0x3BA, 0x3BF, 0x3C0 };
static const symbol s_39_55[4] = { 0x3C4, 0x3C3, 0x3BF, 0x3C0 };
static const symbol s_39_56[2] = { 0x3C3, 0x3C0 };
static const symbol s_39_57[2] = { 0x3B5, 0x3C1 };
static const symbol s_39_58[3] = { 0x3B3, 0x3B5, 0x3C1 };
static const symbol s_39_59[5] = { 0x3B2, 0x3B5, 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_39_60[6] = { 0x3BB, 0x3BF, 0x3C5, 0x3B8, 0x3B7, 0x3C1 };
static const symbol s_39_61[6] = { 0x3BA, 0x3BF, 0x3C1, 0x3BC, 0x3BF, 0x3C1 };
static const symbol s_39_62[6] = { 0x3C0, 0x3B5, 0x3C1, 0x3B9, 0x3C4, 0x3C1 };
static const symbol s_39_63[3] = { 0x3BF, 0x3C5, 0x3C1 };
static const symbol s_39_64[1] = { 0x3C3 };
static const symbol s_39_65[3] = { 0x3B2, 0x3B1, 0x3C3 };
static const symbol s_39_66[5] = { 0x3C0, 0x3BF, 0x3BB, 0x3B9, 0x3C3 };
static const symbol s_39_67[8] = { 0x3C3, 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B1, 0x3C4, 0x3C3 };
static const symbol s_39_68[3] = { 0x3B8, 0x3C5, 0x3C3 };
static const symbol s_39_69[4] = { 0x3B4, 0x3B9, 0x3B1, 0x3C4 };
static const symbol s_39_70[4] = { 0x3C0, 0x3BB, 0x3B1, 0x3C4 };
static const symbol s_39_71[7] = { 0x3C4, 0x3C3, 0x3B1, 0x3C1, 0x3BB, 0x3B1, 0x3C4 };
static const symbol s_39_72[3] = { 0x3C4, 0x3B5, 0x3C4 };
static const symbol s_39_73[6] = { 0x3C0, 0x3BF, 0x3C5, 0x3C1, 0x3B9, 0x3C4 };
static const symbol s_39_74[5] = { 0x3C3, 0x3BF, 0x3C5, 0x3BB, 0x3C4 };
static const symbol s_39_75[5] = { 0x3BC, 0x3B1, 0x3B9, 0x3BD, 0x3C4 };
static const symbol s_39_76[4] = { 0x3B6, 0x3C9, 0x3BD, 0x3C4 };
static const symbol s_39_77[4] = { 0x3BA, 0x3B1, 0x3C3, 0x3C4 };
static const symbol s_39_78[1] = { 0x3C6 };
static const symbol s_39_79[4] = { 0x3B4, 0x3B9, 0x3B1, 0x3C6 };
static const symbol s_39_80[4] = { 0x3C3, 0x3C4, 0x3B5, 0x3C6 };
static const symbol s_39_81[8] = { 0x3C6, 0x3C9, 0x3C4, 0x3BF, 0x3C3, 0x3C4, 0x3B5, 0x3C6 };
static const symbol s_39_82[5] = { 0x3C0, 0x3B5, 0x3C1, 0x3B7, 0x3C6 };
static const symbol s_39_83[6] = { 0x3C5, 0x3C0, 0x3B5, 0x3C1, 0x3B7, 0x3C6 };
static const symbol s_39_84[7] = { 0x3BA, 0x3BF, 0x3B9, 0x3BB, 0x3B1, 0x3C1, 0x3C6 };
static const symbol s_39_85[7] = { 0x3C0, 0x3B5, 0x3BD, 0x3C4, 0x3B1, 0x3C1, 0x3C6 };
static const symbol s_39_86[3] = { 0x3BF, 0x3C1, 0x3C6 };
static const symbol s_39_87[1] = { 0x3C7 };
static const symbol s_39_88[4] = { 0x3B1, 0x3BC, 0x3B7, 0x3C7 };
static const symbol s_39_89[6] = { 0x3B2, 0x3B9, 0x3BF, 0x3BC, 0x3B7, 0x3C7 };
static const symbol s_39_90[11] = { 0x3BC, 0x3B5, 0x3B3, 0x3BB, 0x3BF, 0x3B2, 0x3B9, 0x3BF, 0x3BC, 0x3B7, 0x3C7 };
static const symbol s_39_91[11] = { 0x3BA, 0x3B1, 0x3C0, 0x3BD, 0x3BF, 0x3B2, 0x3B9, 0x3BF, 0x3BC, 0x3B7, 0x3C7 };
static const symbol s_39_92[11] = { 0x3BC, 0x3B9, 0x3BA, 0x3C1, 0x3BF, 0x3B2, 0x3B9, 0x3BF, 0x3BC, 0x3B7, 0x3C7 };
static const symbol s_39_93[7] = { 0x3C0, 0x3BF, 0x3BB, 0x3C5, 0x3BC, 0x3B7, 0x3C7 };
static const symbol s_39_94[3] = { 0x3BB, 0x3B9, 0x3C7 };
static const struct among a_39[95] = {
{ 3, s_39_0, 0, 1, 0},
{ 4, s_39_1, -1, 1, 0},
{ 7, s_39_2, -2, 1, 0},
{ 3, s_39_3, 0, 1, 0},
{ 4, s_39_4, -1, 1, 0},
{ 8, s_39_5, -1, 1, 0},
{ 1, s_39_6, 0, 1, 0},
{ 2, s_39_7, -1, 1, 0},
{ 4, s_39_8, -1, 1, 0},
{ 4, s_39_9, -2, 1, 0},
{ 5, s_39_10, -4, 1, 0},
{ 5, s_39_11, -5, 1, 0},
{ 6, s_39_12, -1, 1, 0},
{ 4, s_39_13, -7, 1, 0},
{ 4, s_39_14, -8, 1, 0},
{ 3, s_39_15, -9, 1, 0},
{ 5, s_39_16, -10, 1, 0},
{ 5, s_39_17, -11, 1, 0},
{ 7, s_39_18, 0, 1, 0},
{ 1, s_39_19, 0, 1, 0},
{ 6, s_39_20, -1, 1, 0},
{ 3, s_39_21, -2, 1, 0},
{ 4, s_39_22, -1, 1, 0},
{ 3, s_39_23, 0, 1, 0},
{ 5, s_39_24, 0, 1, 0},
{ 2, s_39_25, 0, 1, 0},
{ 4, s_39_26, -1, 1, 0},
{ 5, s_39_27, 0, 1, 0},
{ 4, s_39_28, 0, 1, 0},
{ 6, s_39_29, 0, 1, 0},
{ 3, s_39_30, 0, 1, 0},
{ 7, s_39_31, -1, 1, 0},
{ 6, s_39_32, -2, 1, 0},
{ 7, s_39_33, -3, 1, 0},
{ 3, s_39_34, 0, 1, 0},
{ 6, s_39_35, 0, 1, 0},
{ 6, s_39_36, 0, 1, 0},
{ 2, s_39_37, 0, 1, 0},
{ 4, s_39_38, -1, 1, 0},
{ 5, s_39_39, -2, 1, 0},
{ 6, s_39_40, -3, 1, 0},
{ 3, s_39_41, 0, 1, 0},
{ 1, s_39_42, 0, 1, 0},
{ 8, s_39_43, -1, 1, 0},
{ 8, s_39_44, -2, 1, 0},
{ 7, s_39_45, -3, 1, 0},
{ 5, s_39_46, -4, 1, 0},
{ 1, s_39_47, 0, 1, 0},
{ 8, s_39_48, -1, 1, 0},
{ 1, s_39_49, 0, 1, 0},
{ 4, s_39_50, -1, 1, 0},
{ 9, s_39_51, -2, 1, 0},
{ 7, s_39_52, -3, 1, 0},
{ 3, s_39_53, -4, 1, 0},
{ 6, s_39_54, -1, 1, 0},
{ 4, s_39_55, -6, 1, 0},
{ 2, s_39_56, -7, 1, 0},
{ 2, s_39_57, 0, 1, 0},
{ 3, s_39_58, -1, 1, 0},
{ 5, s_39_59, -2, 1, 0},
{ 6, s_39_60, 0, 1, 0},
{ 6, s_39_61, 0, 1, 0},
{ 6, s_39_62, 0, 1, 0},
{ 3, s_39_63, 0, 1, 0},
{ 1, s_39_64, 0, 1, 0},
{ 3, s_39_65, -1, 1, 0},
{ 5, s_39_66, -2, 1, 0},
{ 8, s_39_67, -3, 1, 0},
{ 3, s_39_68, -4, 1, 0},
{ 4, s_39_69, 0, 1, 0},
{ 4, s_39_70, 0, 1, 0},
{ 7, s_39_71, 0, 1, 0},
{ 3, s_39_72, 0, 1, 0},
{ 6, s_39_73, 0, 1, 0},
{ 5, s_39_74, 0, 1, 0},
{ 5, s_39_75, 0, 1, 0},
{ 4, s_39_76, 0, 1, 0},
{ 4, s_39_77, 0, 1, 0},
{ 1, s_39_78, 0, 1, 0},
{ 4, s_39_79, -1, 1, 0},
{ 4, s_39_80, -2, 1, 0},
{ 8, s_39_81, -1, 1, 0},
{ 5, s_39_82, -4, 1, 0},
{ 6, s_39_83, -1, 1, 0},
{ 7, s_39_84, -6, 1, 0},
{ 7, s_39_85, -7, 1, 0},
{ 3, s_39_86, -8, 1, 0},
{ 1, s_39_87, 0, 1, 0},
{ 4, s_39_88, -1, 1, 0},
{ 6, s_39_89, -2, 1, 0},
{ 11, s_39_90, -1, 1, 0},
{ 11, s_39_91, -2, 1, 0},
{ 11, s_39_92, -3, 1, 0},
{ 7, s_39_93, -6, 1, 0},
{ 3, s_39_94, -7, 1, 0}
};

static const symbol s_40_0[3] = { 0x3B5, 0x3BD, 0x3B4 };
static const symbol s_40_1[4] = { 0x3C3, 0x3C5, 0x3BD, 0x3B4 };
static const symbol s_40_2[2] = { 0x3BF, 0x3B4 };
static const symbol s_40_3[4] = { 0x3B4, 0x3B9, 0x3B1, 0x3B8 };
static const symbol s_40_4[3] = { 0x3BA, 0x3B1, 0x3B8 };
static const symbol s_40_5[3] = { 0x3C1, 0x3B1, 0x3B8 };
static const symbol s_40_6[3] = { 0x3C4, 0x3B1, 0x3B8 };
static const symbol s_40_7[3] = { 0x3C4, 0x3B9, 0x3B8 };
static const symbol s_40_8[3] = { 0x3B5, 0x3BA, 0x3B8 };
static const symbol s_40_9[3] = { 0x3B5, 0x3BD, 0x3B8 };
static const symbol s_40_10[4] = { 0x3C3, 0x3C5, 0x3BD, 0x3B8 };
static const symbol s_40_11[3] = { 0x3C1, 0x3BF, 0x3B8 };
static const symbol s_40_12[5] = { 0x3C5, 0x3C0, 0x3B5, 0x3C1, 0x3B8 };
static const symbol s_40_13[2] = { 0x3C3, 0x3B8 };
static const symbol s_40_14[3] = { 0x3B5, 0x3C5, 0x3B8 };
static const symbol s_40_15[3] = { 0x3B1, 0x3C1, 0x3BA };
static const symbol s_40_16[4] = { 0x3C9, 0x3C6, 0x3B5, 0x3BB };
static const symbol s_40_17[3] = { 0x3B2, 0x3BF, 0x3BB };
static const symbol s_40_18[3] = { 0x3B1, 0x3B9, 0x3BD };
static const symbol s_40_19[3] = { 0x3C0, 0x3BF, 0x3BD };
static const symbol s_40_20[3] = { 0x3C1, 0x3BF, 0x3BD };
static const symbol s_40_21[3] = { 0x3C3, 0x3C5, 0x3BD };
static const symbol s_40_22[3] = { 0x3B2, 0x3B1, 0x3C1 };
static const symbol s_40_23[2] = { 0x3B2, 0x3C1 };
static const symbol s_40_24[3] = { 0x3B1, 0x3B9, 0x3C1 };
static const symbol s_40_25[3] = { 0x3C6, 0x3BF, 0x3C1 };
static const symbol s_40_26[3] = { 0x3B5, 0x3C5, 0x3C1 };
static const symbol s_40_27[3] = { 0x3C0, 0x3C5, 0x3C1 };
static const symbol s_40_28[3] = { 0x3C7, 0x3C9, 0x3C1 };
static const symbol s_40_29[3] = { 0x3BD, 0x3B5, 0x3C4 };
static const symbol s_40_30[2] = { 0x3C3, 0x3C7 };
static const struct among a_40[31] = {
{ 3, s_40_0, 0, 1, 0},
{ 4, s_40_1, 0, 1, 0},
{ 2, s_40_2, 0, 1, 0},
{ 4, s_40_3, 0, 1, 0},
{ 3, s_40_4, 0, 1, 0},
{ 3, s_40_5, 0, 1, 0},
{ 3, s_40_6, 0, 1, 0},
{ 3, s_40_7, 0, 1, 0},
{ 3, s_40_8, 0, 1, 0},
{ 3, s_40_9, 0, 1, 0},
{ 4, s_40_10, 0, 1, 0},
{ 3, s_40_11, 0, 1, 0},
{ 5, s_40_12, 0, 1, 0},
{ 2, s_40_13, 0, 1, 0},
{ 3, s_40_14, 0, 1, 0},
{ 3, s_40_15, 0, 1, 0},
{ 4, s_40_16, 0, 1, 0},
{ 3, s_40_17, 0, 1, 0},
{ 3, s_40_18, 0, 1, 0},
{ 3, s_40_19, 0, 1, 0},
{ 3, s_40_20, 0, 1, 0},
{ 3, s_40_21, 0, 1, 0},
{ 3, s_40_22, 0, 1, 0},
{ 2, s_40_23, 0, 1, 0},
{ 3, s_40_24, 0, 1, 0},
{ 3, s_40_25, 0, 1, 0},
{ 3, s_40_26, 0, 1, 0},
{ 3, s_40_27, 0, 1, 0},
{ 3, s_40_28, 0, 1, 0},
{ 3, s_40_29, 0, 1, 0},
{ 2, s_40_30, 0, 1, 0}
};

static const symbol s_41_0[3] = { 0x3C0, 0x3B1, 0x3B3 };
static const symbol s_41_1[1] = { 0x3B4 };
static const symbol s_41_2[2] = { 0x3B1, 0x3B4 };
static const symbol s_41_3[1] = { 0x3B8 };
static const symbol s_41_4[2] = { 0x3B1, 0x3B8 };
static const symbol s_41_5[3] = { 0x3C4, 0x3BF, 0x3BA };
static const symbol s_41_6[2] = { 0x3C3, 0x3BA };
static const symbol s_41_7[7] = { 0x3C0, 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B1, 0x3BB };
static const symbol s_41_8[4] = { 0x3C3, 0x3BA, 0x3B5, 0x3BB };
static const symbol s_41_9[3] = { 0x3B1, 0x3C0, 0x3BB };
static const symbol s_41_10[2] = { 0x3B5, 0x3BC };
static const symbol s_41_11[2] = { 0x3B1, 0x3BD };
static const symbol s_41_12[3] = { 0x3B2, 0x3B5, 0x3BD };
static const symbol s_41_13[5] = { 0x3B2, 0x3B1, 0x3C1, 0x3BF, 0x3BD };
static const symbol s_41_14[3] = { 0x3BA, 0x3BF, 0x3C0 };
static const symbol s_41_15[4] = { 0x3C3, 0x3B5, 0x3C1, 0x3C0 };
static const symbol s_41_16[4] = { 0x3B1, 0x3B2, 0x3B1, 0x3C1 };
static const symbol s_41_17[4] = { 0x3B5, 0x3BD, 0x3B1, 0x3C1 };
static const symbol s_41_18[3] = { 0x3B1, 0x3B2, 0x3C1 };
static const symbol s_41_19[4] = { 0x3BC, 0x3C0, 0x3BF, 0x3C1 };
static const symbol s_41_20[4] = { 0x3B8, 0x3B1, 0x3C1, 0x3C1 };
static const symbol s_41_21[3] = { 0x3BD, 0x3C4, 0x3C1 };
static const symbol s_41_22[1] = { 0x3C5 };
static const symbol s_41_23[3] = { 0x3BD, 0x3B9, 0x3C6 };
static const symbol s_41_24[4] = { 0x3C3, 0x3C5, 0x3C1, 0x3C6 };
static const struct among a_41[25] = {
{ 3, s_41_0, 0, 1, 0},
{ 1, s_41_1, 0, 1, 0},
{ 2, s_41_2, -1, 1, 0},
{ 1, s_41_3, 0, 1, 0},
{ 2, s_41_4, -1, 1, 0},
{ 3, s_41_5, 0, 1, 0},
{ 2, s_41_6, 0, 1, 0},
{ 7, s_41_7, 0, 1, 0},
{ 4, s_41_8, 0, 1, 0},
{ 3, s_41_9, 0, 1, 0},
{ 2, s_41_10, 0, 1, 0},
{ 2, s_41_11, 0, 1, 0},
{ 3, s_41_12, 0, 1, 0},
{ 5, s_41_13, 0, 1, 0},
{ 3, s_41_14, 0, 1, 0},
{ 4, s_41_15, 0, 1, 0},
{ 4, s_41_16, 0, 1, 0},
{ 4, s_41_17, 0, 1, 0},
{ 3, s_41_18, 0, 1, 0},
{ 4, s_41_19, 0, 1, 0},
{ 4, s_41_20, 0, 1, 0},
{ 3, s_41_21, 0, 1, 0},
{ 1, s_41_22, 0, 1, 0},
{ 3, s_41_23, 0, 1, 0},
{ 4, s_41_24, 0, 1, 0}
};

static const symbol s_42_0[5] = { 0x3BF, 0x3BD, 0x3C4, 0x3B1, 0x3C3 };
static const symbol s_42_1[5] = { 0x3C9, 0x3BD, 0x3C4, 0x3B1, 0x3C3 };
static const struct among a_42[2] = {
{ 5, s_42_0, 0, 1, 0},
{ 5, s_42_1, 0, 1, 0}
};

static const symbol s_43_0[6] = { 0x3BF, 0x3BC, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_43_1[7] = { 0x3B9, 0x3BF, 0x3BC, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const struct among a_43[2] = {
{ 6, s_43_0, 0, 1, 0},
{ 7, s_43_1, -1, 1, 0}
};

static const symbol s_44_0[1] = { 0x3C0 };
static const symbol s_44_1[2] = { 0x3B1, 0x3C0 };
static const symbol s_44_2[6] = { 0x3B1, 0x3BA, 0x3B1, 0x3C4, 0x3B1, 0x3C0 };
static const symbol s_44_3[4] = { 0x3C3, 0x3C5, 0x3BC, 0x3C0 };
static const symbol s_44_4[5] = { 0x3B1, 0x3C3, 0x3C5, 0x3BC, 0x3C0 };
static const symbol s_44_5[7] = { 0x3B1, 0x3BC, 0x3B5, 0x3C4, 0x3B1, 0x3BC, 0x3C6 };
static const struct among a_44[6] = {
{ 1, s_44_0, 0, 1, 0},
{ 2, s_44_1, -1, 1, 0},
{ 6, s_44_2, -1, 1, 0},
{ 4, s_44_3, -3, 1, 0},
{ 5, s_44_4, -1, 1, 0},
{ 7, s_44_5, 0, 1, 0}
};

static const symbol s_45_0[1] = { 0x3B6 };
static const symbol s_45_1[2] = { 0x3B1, 0x3BB };
static const symbol s_45_2[7] = { 0x3C0, 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B1, 0x3BB };
static const symbol s_45_3[5] = { 0x3B5, 0x3BA, 0x3C4, 0x3B5, 0x3BB };
static const symbol s_45_4[1] = { 0x3BC };
static const symbol s_45_5[1] = { 0x3BE };
static const symbol s_45_6[3] = { 0x3C0, 0x3C1, 0x3BF };
static const symbol s_45_7[2] = { 0x3B1, 0x3C1 };
static const symbol s_45_8[3] = { 0x3BD, 0x3B9, 0x3C3 };
static const struct among a_45[9] = {
{ 1, s_45_0, 0, 1, 0},
{ 2, s_45_1, 0, 1, 0},
{ 7, s_45_2, -1, 1, 0},
{ 5, s_45_3, 0, 1, 0},
{ 1, s_45_4, 0, 1, 0},
{ 1, s_45_5, 0, 1, 0},
{ 3, s_45_6, 0, 1, 0},
{ 2, s_45_7, 0, 1, 0},
{ 3, s_45_8, 0, 1, 0}
};

static const symbol s_46_0[5] = { 0x3B7, 0x3B8, 0x3B7, 0x3BA, 0x3B1 };
static const symbol s_46_1[5] = { 0x3B7, 0x3B8, 0x3B7, 0x3BA, 0x3B5 };
static const symbol s_46_2[6] = { 0x3B7, 0x3B8, 0x3B7, 0x3BA, 0x3B5, 0x3C3 };
static const struct among a_46[3] = {
{ 5, s_46_0, 0, 1, 0},
{ 5, s_46_1, 0, 1, 0},
{ 6, s_46_2, 0, 1, 0}
};

static const symbol s_47_0[3] = { 0x3C0, 0x3B9, 0x3B8 };
static const symbol s_47_1[2] = { 0x3BF, 0x3B8 };
static const symbol s_47_2[4] = { 0x3BD, 0x3B1, 0x3C1, 0x3B8 };
static const symbol s_47_3[5] = { 0x3C3, 0x3BA, 0x3BF, 0x3C5, 0x3BB };
static const symbol s_47_4[4] = { 0x3C3, 0x3BA, 0x3C9, 0x3BB };
static const symbol s_47_5[2] = { 0x3C3, 0x3C6 };
static const struct among a_47[6] = {
{ 3, s_47_0, 0, 1, 0},
{ 2, s_47_1, 0, 1, 0},
{ 4, s_47_2, 0, 1, 0},
{ 5, s_47_3, 0, 1, 0},
{ 4, s_47_4, 0, 1, 0},
{ 2, s_47_5, 0, 1, 0}
};

static const symbol s_48_0[1] = { 0x3B8 };
static const symbol s_48_1[4] = { 0x3B4, 0x3B9, 0x3B1, 0x3B8 };
static const symbol s_48_2[9] = { 0x3C0, 0x3B1, 0x3C1, 0x3B1, 0x3BA, 0x3B1, 0x3C4, 0x3B1, 0x3B8 };
static const symbol s_48_3[4] = { 0x3C3, 0x3C5, 0x3BD, 0x3B8 };
static const symbol s_48_4[5] = { 0x3C0, 0x3C1, 0x3BF, 0x3C3, 0x3B8 };
static const struct among a_48[5] = {
{ 1, s_48_0, 0, 1, 0},
{ 4, s_48_1, -1, 1, 0},
{ 9, s_48_2, -2, 1, 0},
{ 4, s_48_3, -3, 1, 0},
{ 5, s_48_4, -4, 1, 0}
};

static const symbol s_49_0[3] = { 0x3B7, 0x3BA, 0x3B1 };
static const symbol s_49_1[3] = { 0x3B7, 0x3BA, 0x3B5 };
static const symbol s_49_2[4] = { 0x3B7, 0x3BA, 0x3B5, 0x3C3 };
static const struct among a_49[3] = {
{ 3, s_49_0, 0, 1, 0},
{ 3, s_49_1, 0, 1, 0},
{ 4, s_49_2, 0, 1, 0}
};

static const symbol s_50_0[3] = { 0x3C6, 0x3B1, 0x3B3 };
static const symbol s_50_1[3] = { 0x3BB, 0x3B7, 0x3B3 };
static const symbol s_50_2[4] = { 0x3C6, 0x3C1, 0x3C5, 0x3B4 };
static const symbol s_50_3[6] = { 0x3BC, 0x3B1, 0x3BD, 0x3C4, 0x3B9, 0x3BB };
static const symbol s_50_4[4] = { 0x3BC, 0x3B1, 0x3BB, 0x3BB };
static const symbol s_50_5[2] = { 0x3BF, 0x3BC };
static const symbol s_50_6[4] = { 0x3B2, 0x3BB, 0x3B5, 0x3C0 };
static const symbol s_50_7[5] = { 0x3C0, 0x3BF, 0x3B4, 0x3B1, 0x3C1 };
static const symbol s_50_8[5] = { 0x3BA, 0x3C5, 0x3BC, 0x3B1, 0x3C4 };
static const symbol s_50_9[4] = { 0x3C0, 0x3C1, 0x3C9, 0x3C4 };
static const symbol s_50_10[3] = { 0x3BB, 0x3B1, 0x3C7 };
static const symbol s_50_11[6] = { 0x3C0, 0x3B1, 0x3BD, 0x3C4, 0x3B1, 0x3C7 };
static const struct among a_50[12] = {
{ 3, s_50_0, 0, 1, 0},
{ 3, s_50_1, 0, 1, 0},
{ 4, s_50_2, 0, 1, 0},
{ 6, s_50_3, 0, 1, 0},
{ 4, s_50_4, 0, 1, 0},
{ 2, s_50_5, 0, 1, 0},
{ 4, s_50_6, 0, 1, 0},
{ 5, s_50_7, 0, 1, 0},
{ 5, s_50_8, 0, 1, 0},
{ 4, s_50_9, 0, 1, 0},
{ 3, s_50_10, 0, 1, 0},
{ 6, s_50_11, 0, 1, 0}
};

static const symbol s_51_0[3] = { 0x3C4, 0x3C3, 0x3B1 };
static const symbol s_51_1[3] = { 0x3C7, 0x3B1, 0x3B4 };
static const symbol s_51_2[3] = { 0x3BC, 0x3B5, 0x3B4 };
static const symbol s_51_3[6] = { 0x3BB, 0x3B1, 0x3BC, 0x3C0, 0x3B9, 0x3B4 };
static const symbol s_51_4[2] = { 0x3B4, 0x3B5 };
static const symbol s_51_5[3] = { 0x3C0, 0x3BB, 0x3B5 };
static const symbol s_51_6[5] = { 0x3BC, 0x3B5, 0x3C3, 0x3B1, 0x3B6 };
static const symbol s_51_7[6] = { 0x3B4, 0x3B5, 0x3C3, 0x3C0, 0x3BF, 0x3B6 };
static const symbol s_51_8[3] = { 0x3B1, 0x3B9, 0x3B8 };
static const symbol s_51_9[6] = { 0x3C6, 0x3B1, 0x3C1, 0x3BC, 0x3B1, 0x3BA };
static const symbol s_51_10[3] = { 0x3B1, 0x3B3, 0x3BA };
static const symbol s_51_11[4] = { 0x3B1, 0x3BD, 0x3B7, 0x3BA };
static const symbol s_51_12[1] = { 0x3BB };
static const symbol s_51_13[1] = { 0x3BC };
static const symbol s_51_14[2] = { 0x3B1, 0x3BC };
static const symbol s_51_15[4] = { 0x3B2, 0x3C1, 0x3BF, 0x3BC };
static const symbol s_51_16[7] = { 0x3C5, 0x3C0, 0x3BF, 0x3C4, 0x3B5, 0x3B9, 0x3BD };
static const symbol s_51_17[5] = { 0x3B5, 0x3BA, 0x3BB, 0x3B9, 0x3C0 };
static const symbol s_51_18[1] = { 0x3C1 };
static const symbol s_51_19[8] = { 0x3B5, 0x3BD, 0x3B4, 0x3B9, 0x3B1, 0x3C6, 0x3B5, 0x3C1 };
static const symbol s_51_20[5] = { 0x3B1, 0x3BD, 0x3B1, 0x3C1, 0x3C1 };
static const symbol s_51_21[3] = { 0x3C0, 0x3B1, 0x3C4 };
static const symbol s_51_22[7] = { 0x3BA, 0x3B1, 0x3B8, 0x3B1, 0x3C1, 0x3B5, 0x3C5 };
static const symbol s_51_23[8] = { 0x3B4, 0x3B5, 0x3C5, 0x3C4, 0x3B5, 0x3C1, 0x3B5, 0x3C5 };
static const symbol s_51_24[3] = { 0x3BB, 0x3B5, 0x3C7 };
static const struct among a_51[25] = {
{ 3, s_51_0, 0, 1, 0},
{ 3, s_51_1, 0, 1, 0},
{ 3, s_51_2, 0, 1, 0},
{ 6, s_51_3, 0, 1, 0},
{ 2, s_51_4, 0, 1, 0},
{ 3, s_51_5, 0, 1, 0},
{ 5, s_51_6, 0, 1, 0},
{ 6, s_51_7, 0, 1, 0},
{ 3, s_51_8, 0, 1, 0},
{ 6, s_51_9, 0, 1, 0},
{ 3, s_51_10, 0, 1, 0},
{ 4, s_51_11, 0, 1, 0},
{ 1, s_51_12, 0, 1, 0},
{ 1, s_51_13, 0, 1, 0},
{ 2, s_51_14, -1, 1, 0},
{ 4, s_51_15, -2, 1, 0},
{ 7, s_51_16, 0, 1, 0},
{ 5, s_51_17, 0, 1, 0},
{ 1, s_51_18, 0, 1, 0},
{ 8, s_51_19, -1, 1, 0},
{ 5, s_51_20, -2, 1, 0},
{ 3, s_51_21, 0, 1, 0},
{ 7, s_51_22, 0, 1, 0},
{ 8, s_51_23, 0, 1, 0},
{ 3, s_51_24, 0, 1, 0}
};

static const symbol s_52_0[4] = { 0x3BF, 0x3C5, 0x3C3, 0x3B1 };
static const symbol s_52_1[4] = { 0x3BF, 0x3C5, 0x3C3, 0x3B5 };
static const symbol s_52_2[5] = { 0x3BF, 0x3C5, 0x3C3, 0x3B5, 0x3C3 };
static const struct among a_52[3] = {
{ 4, s_52_0, 0, 1, 0},
{ 4, s_52_1, 0, 1, 0},
{ 5, s_52_2, 0, 1, 0}
};

static const symbol s_53_0[3] = { 0x3C0, 0x3B5, 0x3BB };
static const symbol s_53_1[2] = { 0x3BB, 0x3BB };
static const symbol s_53_2[4] = { 0x3C3, 0x3BC, 0x3B7, 0x3BD };
static const symbol s_53_3[2] = { 0x3C1, 0x3C0 };
static const symbol s_53_4[2] = { 0x3C0, 0x3C1 };
static const symbol s_53_5[2] = { 0x3C6, 0x3C1 };
static const symbol s_53_6[4] = { 0x3C7, 0x3BF, 0x3C1, 0x3C4 };
static const symbol s_53_7[2] = { 0x3BF, 0x3C6 };
static const symbol s_53_8[3] = { 0x3C8, 0x3BF, 0x3C6 };
static const symbol s_53_9[2] = { 0x3C3, 0x3C6 };
static const symbol s_53_10[3] = { 0x3BB, 0x3BF, 0x3C7 };
static const symbol s_53_11[6] = { 0x3BD, 0x3B1, 0x3C5, 0x3BB, 0x3BF, 0x3C7 };
static const struct among a_53[12] = {
{ 3, s_53_0, 0, 1, 0},
{ 2, s_53_1, 0, 1, 0},
{ 4, s_53_2, 0, 1, 0},
{ 2, s_53_3, 0, 1, 0},
{ 2, s_53_4, 0, 1, 0},
{ 2, s_53_5, 0, 1, 0},
{ 4, s_53_6, 0, 1, 0},
{ 2, s_53_7, 0, 1, 0},
{ 3, s_53_8, -1, -1, 0},
{ 2, s_53_9, 0, 1, 0},
{ 3, s_53_10, 0, 1, 0},
{ 6, s_53_11, -1, -1, 0}
};

static const symbol s_54_0[6] = { 0x3B1, 0x3BC, 0x3B1, 0x3BB, 0x3BB, 0x3B9 };
static const symbol s_54_1[1] = { 0x3BB };
static const symbol s_54_2[4] = { 0x3B1, 0x3BC, 0x3B1, 0x3BB };
static const symbol s_54_3[1] = { 0x3BC };
static const symbol s_54_4[5] = { 0x3BF, 0x3C5, 0x3BB, 0x3B1, 0x3BC };
static const symbol s_54_5[2] = { 0x3B5, 0x3BD };
static const symbol s_54_6[6] = { 0x3B4, 0x3B5, 0x3C1, 0x3B2, 0x3B5, 0x3BD };
static const symbol s_54_7[1] = { 0x3C0 };
static const symbol s_54_8[4] = { 0x3B1, 0x3B5, 0x3B9, 0x3C0 };
static const symbol s_54_9[5] = { 0x3B1, 0x3C1, 0x3C4, 0x3B9, 0x3C0 };
static const symbol s_54_10[4] = { 0x3C3, 0x3C5, 0x3BC, 0x3C0 };
static const symbol s_54_11[4] = { 0x3BD, 0x3B5, 0x3BF, 0x3C0 };
static const symbol s_54_12[8] = { 0x3BA, 0x3C1, 0x3BF, 0x3BA, 0x3B1, 0x3BB, 0x3BF, 0x3C0 };
static const symbol s_54_13[4] = { 0x3BF, 0x3BB, 0x3BF, 0x3C0 };
static const symbol s_54_14[8] = { 0x3C0, 0x3C1, 0x3BF, 0x3C3, 0x3C9, 0x3C0, 0x3BF, 0x3C0 };
static const symbol s_54_15[7] = { 0x3C3, 0x3B9, 0x3B4, 0x3B7, 0x3C1, 0x3BF, 0x3C0 };
static const symbol s_54_16[6] = { 0x3B4, 0x3C1, 0x3BF, 0x3C3, 0x3BF, 0x3C0 };
static const symbol s_54_17[3] = { 0x3B1, 0x3C3, 0x3C0 };
static const symbol s_54_18[4] = { 0x3B1, 0x3BD, 0x3C5, 0x3C0 };
static const symbol s_54_19[1] = { 0x3C1 };
static const symbol s_54_20[5] = { 0x3B1, 0x3C3, 0x3C0, 0x3B1, 0x3C1 };
static const symbol s_54_21[3] = { 0x3C7, 0x3B1, 0x3C1 };
static const symbol s_54_22[4] = { 0x3B1, 0x3C7, 0x3B1, 0x3C1 };
static const symbol s_54_23[4] = { 0x3B1, 0x3C0, 0x3B5, 0x3C1 };
static const symbol s_54_24[2] = { 0x3C4, 0x3C1 };
static const symbol s_54_25[3] = { 0x3BF, 0x3C5, 0x3C1 };
static const symbol s_54_26[1] = { 0x3C4 };
static const symbol s_54_27[4] = { 0x3B4, 0x3B9, 0x3B1, 0x3C4 };
static const symbol s_54_28[4] = { 0x3B5, 0x3C0, 0x3B9, 0x3C4 };
static const symbol s_54_29[4] = { 0x3C3, 0x3C5, 0x3BD, 0x3C4 };
static const symbol s_54_30[4] = { 0x3BF, 0x3BC, 0x3BF, 0x3C4 };
static const symbol s_54_31[5] = { 0x3BD, 0x3BF, 0x3BC, 0x3BF, 0x3C4 };
static const symbol s_54_32[4] = { 0x3B1, 0x3C0, 0x3BF, 0x3C4 };
static const symbol s_54_33[4] = { 0x3C5, 0x3C0, 0x3BF, 0x3C4 };
static const symbol s_54_34[5] = { 0x3B1, 0x3B2, 0x3B1, 0x3C3, 0x3C4 };
static const symbol s_54_35[6] = { 0x3B1, 0x3B9, 0x3BC, 0x3BF, 0x3C3, 0x3C4 };
static const symbol s_54_36[5] = { 0x3C0, 0x3C1, 0x3BF, 0x3C3, 0x3C4 };
static const symbol s_54_37[5] = { 0x3B1, 0x3BD, 0x3C5, 0x3C3, 0x3C4 };
static const symbol s_54_38[3] = { 0x3BD, 0x3B1, 0x3C5 };
static const symbol s_54_39[2] = { 0x3B1, 0x3C6 };
static const symbol s_54_40[3] = { 0x3BE, 0x3B5, 0x3C6 };
static const symbol s_54_41[4] = { 0x3B1, 0x3B4, 0x3B7, 0x3C6 };
static const symbol s_54_42[4] = { 0x3C0, 0x3B1, 0x3BC, 0x3C6 };
static const symbol s_54_43[5] = { 0x3C0, 0x3BF, 0x3BB, 0x3C5, 0x3C6 };
static const struct among a_54[44] = {
{ 6, s_54_0, 0, 1, 0},
{ 1, s_54_1, 0, 1, 0},
{ 4, s_54_2, -1, 1, 0},
{ 1, s_54_3, 0, 1, 0},
{ 5, s_54_4, -1, 1, 0},
{ 2, s_54_5, 0, 1, 0},
{ 6, s_54_6, -1, 1, 0},
{ 1, s_54_7, 0, 1, 0},
{ 4, s_54_8, -1, 1, 0},
{ 5, s_54_9, -2, 1, 0},
{ 4, s_54_10, -3, 1, 0},
{ 4, s_54_11, -4, 1, 0},
{ 8, s_54_12, -5, 1, 0},
{ 4, s_54_13, -6, 1, 0},
{ 8, s_54_14, -7, 1, 0},
{ 7, s_54_15, -8, 1, 0},
{ 6, s_54_16, -9, 1, 0},
{ 3, s_54_17, -10, 1, 0},
{ 4, s_54_18, -11, 1, 0},
{ 1, s_54_19, 0, 1, 0},
{ 5, s_54_20, -1, 1, 0},
{ 3, s_54_21, -2, 1, 0},
{ 4, s_54_22, -1, 1, 0},
{ 4, s_54_23, -4, 1, 0},
{ 2, s_54_24, -5, 1, 0},
{ 3, s_54_25, -6, 1, 0},
{ 1, s_54_26, 0, 1, 0},
{ 4, s_54_27, -1, 1, 0},
{ 4, s_54_28, -2, 1, 0},
{ 4, s_54_29, -3, 1, 0},
{ 4, s_54_30, -4, 1, 0},
{ 5, s_54_31, -1, 1, 0},
{ 4, s_54_32, -6, 1, 0},
{ 4, s_54_33, -7, 1, 0},
{ 5, s_54_34, -8, 1, 0},
{ 6, s_54_35, -9, 1, 0},
{ 5, s_54_36, -10, 1, 0},
{ 5, s_54_37, -11, 1, 0},
{ 3, s_54_38, 0, 1, 0},
{ 2, s_54_39, 0, 1, 0},
{ 3, s_54_40, 0, 1, 0},
{ 4, s_54_41, 0, 1, 0},
{ 4, s_54_42, 0, 1, 0},
{ 5, s_54_43, 0, 1, 0}
};

static const symbol s_55_0[3] = { 0x3B1, 0x3B3, 0x3B1 };
static const symbol s_55_1[3] = { 0x3B1, 0x3B3, 0x3B5 };
static const symbol s_55_2[4] = { 0x3B1, 0x3B3, 0x3B5, 0x3C3 };
static const struct among a_55[3] = {
{ 3, s_55_0, 0, 1, 0},
{ 3, s_55_1, 0, 1, 0},
{ 4, s_55_2, 0, 1, 0}
};

static const symbol s_56_0[3] = { 0x3B7, 0x3C3, 0x3B1 };
static const symbol s_56_1[3] = { 0x3B7, 0x3C3, 0x3B5 };
static const symbol s_56_2[4] = { 0x3B7, 0x3C3, 0x3BF, 0x3C5 };
static const struct among a_56[3] = {
{ 3, s_56_0, 0, 1, 0},
{ 3, s_56_1, 0, 1, 0},
{ 4, s_56_2, 0, 1, 0}
};

static const symbol s_57_0[1] = { 0x3BD };
static const symbol s_57_1[7] = { 0x3B4, 0x3C9, 0x3B4, 0x3B5, 0x3BA, 0x3B1, 0x3BD };
static const symbol s_57_2[5] = { 0x3B5, 0x3C0, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_57_3[7] = { 0x3BC, 0x3B5, 0x3B3, 0x3B1, 0x3BB, 0x3BF, 0x3BD };
static const symbol s_57_4[6] = { 0x3B5, 0x3C1, 0x3B7, 0x3BC, 0x3BF, 0x3BD };
static const symbol s_57_5[6] = { 0x3C7, 0x3B5, 0x3C1, 0x3C3, 0x3BF, 0x3BD };
static const struct among a_57[6] = {
{ 1, s_57_0, 0, 1, 0},
{ 7, s_57_1, -1, 1, 0},
{ 5, s_57_2, -2, 1, 0},
{ 7, s_57_3, -3, 1, 0},
{ 6, s_57_4, -4, 1, 0},
{ 6, s_57_5, -5, 1, 0}
};

static const symbol s_58_0[2] = { 0x3C3, 0x3B2 };
static const symbol s_58_1[3] = { 0x3B1, 0x3C3, 0x3B2 };
static const symbol s_58_2[3] = { 0x3B1, 0x3C0, 0x3BB };
static const symbol s_58_3[5] = { 0x3B1, 0x3B5, 0x3B9, 0x3BC, 0x3BD };
static const symbol s_58_4[2] = { 0x3C7, 0x3C1 };
static const symbol s_58_5[3] = { 0x3B1, 0x3C7, 0x3C1 };
static const symbol s_58_6[7] = { 0x3BA, 0x3BF, 0x3B9, 0x3BD, 0x3BF, 0x3C7, 0x3C1 };
static const symbol s_58_7[5] = { 0x3B4, 0x3C5, 0x3C3, 0x3C7, 0x3C1 };
static const symbol s_58_8[4] = { 0x3B5, 0x3C5, 0x3C7, 0x3C1 };
static const symbol s_58_9[6] = { 0x3C0, 0x3B1, 0x3BB, 0x3B9, 0x3BC, 0x3C8 };
static const struct among a_58[10] = {
{ 2, s_58_0, 0, 1, 0},
{ 3, s_58_1, -1, 1, 0},
{ 3, s_58_2, 0, 1, 0},
{ 5, s_58_3, 0, 1, 0},
{ 2, s_58_4, 0, 1, 0},
{ 3, s_58_5, -1, 1, 0},
{ 7, s_58_6, -2, 1, 0},
{ 5, s_58_7, -3, 1, 0},
{ 4, s_58_8, -4, 1, 0},
{ 6, s_58_9, 0, 1, 0}
};

static const symbol s_59_0[4] = { 0x3BF, 0x3C5, 0x3BD, 0x3B5 };
static const symbol s_59_1[6] = { 0x3B7, 0x3B8, 0x3BF, 0x3C5, 0x3BD, 0x3B5 };
static const symbol s_59_2[6] = { 0x3B7, 0x3C3, 0x3BF, 0x3C5, 0x3BD, 0x3B5 };
static const struct among a_59[3] = {
{ 4, s_59_0, 0, 1, 0},
{ 6, s_59_1, -1, 1, 0},
{ 6, s_59_2, -2, 1, 0}
};

static const symbol s_60_0[3] = { 0x3C3, 0x3C0, 0x3B9 };
static const symbol s_60_1[1] = { 0x3BD };
static const symbol s_60_2[4] = { 0x3B5, 0x3BE, 0x3C9, 0x3BD };
static const symbol s_60_3[1] = { 0x3C1 };
static const symbol s_60_4[11] = { 0x3C3, 0x3C4, 0x3C1, 0x3B1, 0x3B2, 0x3BF, 0x3BC, 0x3BF, 0x3C5, 0x3C4, 0x3C3 };
static const symbol s_60_5[9] = { 0x3BA, 0x3B1, 0x3BA, 0x3BF, 0x3BC, 0x3BF, 0x3C5, 0x3C4, 0x3C3 };
static const struct among a_60[6] = {
{ 3, s_60_0, 0, 1, 0},
{ 1, s_60_1, 0, 1, 0},
{ 4, s_60_2, -1, 1, 0},
{ 1, s_60_3, 0, 1, 0},
{ 11, s_60_4, 0, 1, 0},
{ 9, s_60_5, 0, 1, 0}
};

static const symbol s_61_0[4] = { 0x3BF, 0x3C5, 0x3BC, 0x3B5 };
static const symbol s_61_1[6] = { 0x3B7, 0x3B8, 0x3BF, 0x3C5, 0x3BC, 0x3B5 };
static const symbol s_61_2[6] = { 0x3B7, 0x3C3, 0x3BF, 0x3C5, 0x3BC, 0x3B5 };
static const struct among a_61[3] = {
{ 4, s_61_0, 0, 1, 0},
{ 6, s_61_1, -1, 1, 0},
{ 6, s_61_2, -2, 1, 0}
};

static const symbol s_62_0[2] = { 0x3B1, 0x3B6 };
static const symbol s_62_1[6] = { 0x3C9, 0x3C1, 0x3B9, 0x3BF, 0x3C0, 0x3BB };
static const symbol s_62_2[5] = { 0x3B1, 0x3C3, 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_62_3[8] = { 0x3C0, 0x3B1, 0x3C1, 0x3B1, 0x3C3, 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_62_4[8] = { 0x3B1, 0x3BB, 0x3BB, 0x3BF, 0x3C3, 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_62_5[1] = { 0x3C6 };
static const symbol s_62_6[1] = { 0x3C7 };
static const struct among a_62[7] = {
{ 2, s_62_0, 0, 1, 0},
{ 6, s_62_1, 0, 1, 0},
{ 5, s_62_2, 0, 1, 0},
{ 8, s_62_3, -1, 1, 0},
{ 8, s_62_4, 0, 1, 0},
{ 1, s_62_5, 0, 1, 0},
{ 1, s_62_6, 0, 1, 0}
};

static const symbol s_63_0[4] = { 0x3BC, 0x3B1, 0x3C4, 0x3B1 };
static const symbol s_63_1[5] = { 0x3BC, 0x3B1, 0x3C4, 0x3C9, 0x3BD };
static const symbol s_63_2[5] = { 0x3BC, 0x3B1, 0x3C4, 0x3BF, 0x3C3 };
static const struct among a_63[3] = {
{ 4, s_63_0, 0, 1, 0},
{ 5, s_63_1, 0, 1, 0},
{ 5, s_63_2, 0, 1, 0}
};

static const symbol s_64_0[1] = { 0x3B1 };
static const symbol s_64_1[5] = { 0x3B9, 0x3BF, 0x3C5, 0x3BC, 0x3B1 };
static const symbol s_64_2[6] = { 0x3BF, 0x3BC, 0x3BF, 0x3C5, 0x3BD, 0x3B1 };
static const symbol s_64_3[7] = { 0x3B9, 0x3BF, 0x3BC, 0x3BF, 0x3C5, 0x3BD, 0x3B1 };
static const symbol s_64_4[6] = { 0x3BF, 0x3C3, 0x3BF, 0x3C5, 0x3BD, 0x3B1 };
static const symbol s_64_5[7] = { 0x3B9, 0x3BF, 0x3C3, 0x3BF, 0x3C5, 0x3BD, 0x3B1 };
static const symbol s_64_6[1] = { 0x3B5 };
static const symbol s_64_7[5] = { 0x3B1, 0x3B3, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_64_8[5] = { 0x3B7, 0x3BA, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_64_9[7] = { 0x3B7, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_64_10[5] = { 0x3B7, 0x3C3, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_64_11[6] = { 0x3BF, 0x3C5, 0x3C3, 0x3B1, 0x3C4, 0x3B5 };
static const symbol s_64_12[4] = { 0x3B5, 0x3B9, 0x3C4, 0x3B5 };
static const symbol s_64_13[6] = { 0x3B7, 0x3B8, 0x3B5, 0x3B9, 0x3C4, 0x3B5 };
static const symbol s_64_14[7] = { 0x3B9, 0x3B5, 0x3BC, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_64_15[7] = { 0x3BF, 0x3C5, 0x3BC, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_64_16[8] = { 0x3B9, 0x3BF, 0x3C5, 0x3BC, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_64_17[7] = { 0x3B9, 0x3B5, 0x3C3, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_64_18[6] = { 0x3BF, 0x3C3, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_64_19[7] = { 0x3B9, 0x3BF, 0x3C3, 0x3B1, 0x3C3, 0x3C4, 0x3B5 };
static const symbol s_64_20[1] = { 0x3B7 };
static const symbol s_64_21[1] = { 0x3B9 };
static const symbol s_64_22[4] = { 0x3B1, 0x3BC, 0x3B1, 0x3B9 };
static const symbol s_64_23[5] = { 0x3B9, 0x3B5, 0x3BC, 0x3B1, 0x3B9 };
static const symbol s_64_24[4] = { 0x3BF, 0x3BC, 0x3B1, 0x3B9 };
static const symbol s_64_25[5] = { 0x3BF, 0x3C5, 0x3BC, 0x3B1, 0x3B9 };
static const symbol s_64_26[4] = { 0x3B1, 0x3C3, 0x3B1, 0x3B9 };
static const symbol s_64_27[4] = { 0x3B5, 0x3C3, 0x3B1, 0x3B9 };
static const symbol s_64_28[5] = { 0x3B9, 0x3B5, 0x3C3, 0x3B1, 0x3B9 };
static const symbol s_64_29[4] = { 0x3B1, 0x3C4, 0x3B1, 0x3B9 };
static const symbol s_64_30[4] = { 0x3B5, 0x3C4, 0x3B1, 0x3B9 };
static const symbol s_64_31[5] = { 0x3B9, 0x3B5, 0x3C4, 0x3B1, 0x3B9 };
static const symbol s_64_32[5] = { 0x3BF, 0x3BD, 0x3C4, 0x3B1, 0x3B9 };
static const symbol s_64_33[6] = { 0x3BF, 0x3C5, 0x3BD, 0x3C4, 0x3B1, 0x3B9 };
static const symbol s_64_34[7] = { 0x3B9, 0x3BF, 0x3C5, 0x3BD, 0x3C4, 0x3B1, 0x3B9 };
static const symbol s_64_35[2] = { 0x3B5, 0x3B9 };
static const symbol s_64_36[3] = { 0x3B1, 0x3B5, 0x3B9 };
static const symbol s_64_37[4] = { 0x3B7, 0x3B8, 0x3B5, 0x3B9 };
static const symbol s_64_38[4] = { 0x3B7, 0x3C3, 0x3B5, 0x3B9 };
static const symbol s_64_39[2] = { 0x3BF, 0x3B9 };
static const symbol s_64_40[2] = { 0x3B1, 0x3BD };
static const symbol s_64_41[4] = { 0x3B1, 0x3B3, 0x3B1, 0x3BD };
static const symbol s_64_42[4] = { 0x3B7, 0x3BA, 0x3B1, 0x3BD };
static const symbol s_64_43[6] = { 0x3B7, 0x3B8, 0x3B7, 0x3BA, 0x3B1, 0x3BD };
static const symbol s_64_44[4] = { 0x3B7, 0x3C3, 0x3B1, 0x3BD };
static const symbol s_64_45[5] = { 0x3BF, 0x3C5, 0x3C3, 0x3B1, 0x3BD };
static const symbol s_64_46[8] = { 0x3BF, 0x3BD, 0x3C4, 0x3BF, 0x3C5, 0x3C3, 0x3B1, 0x3BD };
static const symbol s_64_47[9] = { 0x3B9, 0x3BF, 0x3BD, 0x3C4, 0x3BF, 0x3C5, 0x3C3, 0x3B1, 0x3BD };
static const symbol s_64_48[5] = { 0x3BF, 0x3BD, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_49[6] = { 0x3B9, 0x3BF, 0x3BD, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_50[6] = { 0x3BF, 0x3C5, 0x3BD, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_51[7] = { 0x3B9, 0x3BF, 0x3C5, 0x3BD, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_52[4] = { 0x3BF, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_53[5] = { 0x3B9, 0x3BF, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_54[7] = { 0x3BF, 0x3BC, 0x3B1, 0x3C3, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_55[8] = { 0x3B9, 0x3BF, 0x3BC, 0x3B1, 0x3C3, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_56[7] = { 0x3BF, 0x3C3, 0x3B1, 0x3C3, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_57[8] = { 0x3B9, 0x3BF, 0x3C3, 0x3B1, 0x3C3, 0x3C4, 0x3B1, 0x3BD };
static const symbol s_64_58[3] = { 0x3BF, 0x3C5, 0x3BD };
static const symbol s_64_59[5] = { 0x3B7, 0x3B8, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_64_60[5] = { 0x3BF, 0x3BC, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_64_61[6] = { 0x3B9, 0x3BF, 0x3BC, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_64_62[5] = { 0x3B7, 0x3C3, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_64_63[5] = { 0x3BF, 0x3C3, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_64_64[6] = { 0x3B9, 0x3BF, 0x3C3, 0x3BF, 0x3C5, 0x3BD };
static const symbol s_64_65[2] = { 0x3C9, 0x3BD };
static const symbol s_64_66[4] = { 0x3B7, 0x3B4, 0x3C9, 0x3BD };
static const symbol s_64_67[1] = { 0x3BF };
static const symbol s_64_68[2] = { 0x3B1, 0x3C3 };
static const symbol s_64_69[2] = { 0x3B5, 0x3C3 };
static const symbol s_64_70[4] = { 0x3B7, 0x3B4, 0x3B5, 0x3C3 };
static const symbol s_64_71[4] = { 0x3B7, 0x3C3, 0x3B5, 0x3C3 };
static const symbol s_64_72[2] = { 0x3B7, 0x3C3 };
static const symbol s_64_73[3] = { 0x3B5, 0x3B9, 0x3C3 };
static const symbol s_64_74[5] = { 0x3B7, 0x3B8, 0x3B5, 0x3B9, 0x3C3 };
static const symbol s_64_75[2] = { 0x3BF, 0x3C3 };
static const symbol s_64_76[2] = { 0x3C5, 0x3C3 };
static const symbol s_64_77[3] = { 0x3BF, 0x3C5, 0x3C3 };
static const symbol s_64_78[1] = { 0x3C5 };
static const symbol s_64_79[2] = { 0x3BF, 0x3C5 };
static const symbol s_64_80[1] = { 0x3C9 };
static const symbol s_64_81[2] = { 0x3B1, 0x3C9 };
static const symbol s_64_82[3] = { 0x3B7, 0x3B8, 0x3C9 };
static const symbol s_64_83[3] = { 0x3B7, 0x3C3, 0x3C9 };
static const struct among a_64[84] = {
{ 1, s_64_0, 0, 1, 0},
{ 5, s_64_1, -1, 1, 0},
{ 6, s_64_2, -2, 1, 0},
{ 7, s_64_3, -1, 1, 0},
{ 6, s_64_4, -4, 1, 0},
{ 7, s_64_5, -1, 1, 0},
{ 1, s_64_6, 0, 1, 0},
{ 5, s_64_7, -1, 1, 0},
{ 5, s_64_8, -2, 1, 0},
{ 7, s_64_9, -1, 1, 0},
{ 5, s_64_10, -4, 1, 0},
{ 6, s_64_11, -5, 1, 0},
{ 4, s_64_12, -6, 1, 0},
{ 6, s_64_13, -1, 1, 0},
{ 7, s_64_14, -8, 1, 0},
{ 7, s_64_15, -9, 1, 0},
{ 8, s_64_16, -1, 1, 0},
{ 7, s_64_17, -11, 1, 0},
{ 6, s_64_18, -12, 1, 0},
{ 7, s_64_19, -1, 1, 0},
{ 1, s_64_20, 0, 1, 0},
{ 1, s_64_21, 0, 1, 0},
{ 4, s_64_22, -1, 1, 0},
{ 5, s_64_23, -2, 1, 0},
{ 4, s_64_24, -3, 1, 0},
{ 5, s_64_25, -4, 1, 0},
{ 4, s_64_26, -5, 1, 0},
{ 4, s_64_27, -6, 1, 0},
{ 5, s_64_28, -1, 1, 0},
{ 4, s_64_29, -8, 1, 0},
{ 4, s_64_30, -9, 1, 0},
{ 5, s_64_31, -1, 1, 0},
{ 5, s_64_32, -11, 1, 0},
{ 6, s_64_33, -12, 1, 0},
{ 7, s_64_34, -1, 1, 0},
{ 2, s_64_35, -14, 1, 0},
{ 3, s_64_36, -1, 1, 0},
{ 4, s_64_37, -2, 1, 0},
{ 4, s_64_38, -3, 1, 0},
{ 2, s_64_39, -18, 1, 0},
{ 2, s_64_40, 0, 1, 0},
{ 4, s_64_41, -1, 1, 0},
{ 4, s_64_42, -2, 1, 0},
{ 6, s_64_43, -1, 1, 0},
{ 4, s_64_44, -4, 1, 0},
{ 5, s_64_45, -5, 1, 0},
{ 8, s_64_46, -1, 1, 0},
{ 9, s_64_47, -1, 1, 0},
{ 5, s_64_48, -8, 1, 0},
{ 6, s_64_49, -1, 1, 0},
{ 6, s_64_50, -10, 1, 0},
{ 7, s_64_51, -1, 1, 0},
{ 4, s_64_52, -12, 1, 0},
{ 5, s_64_53, -1, 1, 0},
{ 7, s_64_54, -14, 1, 0},
{ 8, s_64_55, -1, 1, 0},
{ 7, s_64_56, -16, 1, 0},
{ 8, s_64_57, -1, 1, 0},
{ 3, s_64_58, 0, 1, 0},
{ 5, s_64_59, -1, 1, 0},
{ 5, s_64_60, -2, 1, 0},
{ 6, s_64_61, -1, 1, 0},
{ 5, s_64_62, -4, 1, 0},
{ 5, s_64_63, -5, 1, 0},
{ 6, s_64_64, -1, 1, 0},
{ 2, s_64_65, 0, 1, 0},
{ 4, s_64_66, -1, 1, 0},
{ 1, s_64_67, 0, 1, 0},
{ 2, s_64_68, 0, 1, 0},
{ 2, s_64_69, 0, 1, 0},
{ 4, s_64_70, -1, 1, 0},
{ 4, s_64_71, -2, 1, 0},
{ 2, s_64_72, 0, 1, 0},
{ 3, s_64_73, 0, 1, 0},
{ 5, s_64_74, -1, 1, 0},
{ 2, s_64_75, 0, 1, 0},
{ 2, s_64_76, 0, 1, 0},
{ 3, s_64_77, -1, 1, 0},
{ 1, s_64_78, 0, 1, 0},
{ 2, s_64_79, -1, 1, 0},
{ 1, s_64_80, 0, 1, 0},
{ 2, s_64_81, -1, 1, 0},
{ 3, s_64_82, -2, 1, 0},
{ 3, s_64_83, -3, 1, 0}
};

static const symbol s_65_0[4] = { 0x3BF, 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_65_1[5] = { 0x3B5, 0x3C3, 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_65_2[4] = { 0x3C5, 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_65_3[4] = { 0x3C9, 0x3C4, 0x3B5, 0x3C1 };
static const symbol s_65_4[4] = { 0x3BF, 0x3C4, 0x3B1, 0x3C4 };
static const symbol s_65_5[5] = { 0x3B5, 0x3C3, 0x3C4, 0x3B1, 0x3C4 };
static const symbol s_65_6[4] = { 0x3C5, 0x3C4, 0x3B1, 0x3C4 };
static const symbol s_65_7[4] = { 0x3C9, 0x3C4, 0x3B1, 0x3C4 };
static const struct among a_65[8] = {
{ 4, s_65_0, 0, 1, 0},
{ 5, s_65_1, 0, 1, 0},
{ 4, s_65_2, 0, 1, 0},
{ 4, s_65_3, 0, 1, 0},
{ 4, s_65_4, 0, 1, 0},
{ 5, s_65_5, 0, 1, 0},
{ 4, s_65_6, 0, 1, 0},
{ 4, s_65_7, 0, 1, 0}
};

static const unsigned char g_v[] = { 81, 65, 16, 1 };

static const unsigned char g_v2[] = { 81, 65, 0, 1 };

extern int greek_stem(struct SN_env * z) {
    int among_var;
    int b_test1;
    z->lb = z->c; z->c = z->l;
    {
        int v_1 = z->l - z->c;
        while (1) {
            int v_2 = z->l - z->c;
            z->ket = z->c;
            among_var = find_among_b(z, a_0, 46, 0);
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 1, s_0);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 1, s_1);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    {
                        int ret = slice_from_s(z, 1, s_2);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    {
                        int ret = slice_from_s(z, 1, s_3);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    {
                        int ret = slice_from_s(z, 1, s_4);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    {
                        int ret = slice_from_s(z, 1, s_5);
                        if (ret < 0) return ret;
                    }
                    break;
                case 7:
                    {
                        int ret = slice_from_s(z, 1, s_6);
                        if (ret < 0) return ret;
                    }
                    break;
                case 8:
                    {
                        int ret = slice_from_s(z, 1, s_7);
                        if (ret < 0) return ret;
                    }
                    break;
                case 9:
                    {
                        int ret = slice_from_s(z, 1, s_8);
                        if (ret < 0) return ret;
                    }
                    break;
                case 10:
                    {
                        int ret = slice_from_s(z, 1, s_9);
                        if (ret < 0) return ret;
                    }
                    break;
                case 11:
                    {
                        int ret = slice_from_s(z, 1, s_10);
                        if (ret < 0) return ret;
                    }
                    break;
                case 12:
                    {
                        int ret = slice_from_s(z, 1, s_11);
                        if (ret < 0) return ret;
                    }
                    break;
                case 13:
                    {
                        int ret = slice_from_s(z, 1, s_12);
                        if (ret < 0) return ret;
                    }
                    break;
                case 14:
                    {
                        int ret = slice_from_s(z, 1, s_13);
                        if (ret < 0) return ret;
                    }
                    break;
                case 15:
                    {
                        int ret = slice_from_s(z, 1, s_14);
                        if (ret < 0) return ret;
                    }
                    break;
                case 16:
                    {
                        int ret = slice_from_s(z, 1, s_15);
                        if (ret < 0) return ret;
                    }
                    break;
                case 17:
                    {
                        int ret = slice_from_s(z, 1, s_16);
                        if (ret < 0) return ret;
                    }
                    break;
                case 18:
                    {
                        int ret = slice_from_s(z, 1, s_17);
                        if (ret < 0) return ret;
                    }
                    break;
                case 19:
                    {
                        int ret = slice_from_s(z, 1, s_18);
                        if (ret < 0) return ret;
                    }
                    break;
                case 20:
                    {
                        int ret = slice_from_s(z, 1, s_19);
                        if (ret < 0) return ret;
                    }
                    break;
                case 21:
                    {
                        int ret = slice_from_s(z, 1, s_20);
                        if (ret < 0) return ret;
                    }
                    break;
                case 22:
                    {
                        int ret = slice_from_s(z, 1, s_21);
                        if (ret < 0) return ret;
                    }
                    break;
                case 23:
                    {
                        int ret = slice_from_s(z, 1, s_22);
                        if (ret < 0) return ret;
                    }
                    break;
                case 24:
                    {
                        int ret = slice_from_s(z, 1, s_23);
                        if (ret < 0) return ret;
                    }
                    break;
                case 25:
                    if (z->c <= z->lb) goto lab1;
                    z->c--;
                    break;
            }
            continue;
        lab1:
            z->c = z->l - v_2;
            break;
        }
        z->c = z->l - v_1;
    }
    if (SIZE(z->p) < 3) return 0;
    b_test1 = 1;
    {
        int v_3 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_1, 40, 0);
        if (!among_var) goto lab2;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 2, s_24);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 3, s_25);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 3, s_26);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 2, s_27);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                {
                    int ret = slice_from_s(z, 4, s_28);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                {
                    int ret = slice_from_s(z, 3, s_29);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                {
                    int ret = slice_from_s(z, 3, s_30);
                    if (ret < 0) return ret;
                }
                break;
            case 8:
                {
                    int ret = slice_from_s(z, 3, s_31);
                    if (ret < 0) return ret;
                }
                break;
            case 9:
                {
                    int ret = slice_from_s(z, 2, s_32);
                    if (ret < 0) return ret;
                }
                break;
            case 10:
                {
                    int ret = slice_from_s(z, 6, s_33);
                    if (ret < 0) return ret;
                }
                break;
            case 11:
                {
                    int ret = slice_from_s(z, 5, s_34);
                    if (ret < 0) return ret;
                }
                break;
        }
        b_test1 = 0;
    lab2:
        z->c = z->l - v_3;
    }
    {
        int v_4 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_3, 14, 0)) goto lab3;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        among_var = find_among_b(z, a_2, 31, 0);
        if (!among_var) goto lab3;
        if (z->c > z->lb) goto lab3;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_35);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 2, s_36);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab3:
        z->c = z->l - v_4;
    }
    {
        int v_5 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_5, 7, 0)) goto lab4;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_4, 8, 0)) goto lab4;
        if (z->c > z->lb) goto lab4;
        {
            int ret = slice_from_s(z, 2, s_37);
            if (ret < 0) return ret;
        }
    lab4:
        z->c = z->l - v_5;
    }
    {
        int v_6 = z->l - z->c;
        do {
            int v_7 = z->l - z->c;
            z->ket = z->c;
            if (!(eq_s_b(z, 3, s_38))) goto lab6;
            z->bra = z->c;
            if (z->c > z->lb) goto lab6;
            {
                int ret = slice_from_s(z, 2, s_39);
                if (ret < 0) return ret;
            }
            break;
        lab6:
            z->c = z->l - v_7;
            z->ket = z->c;
        } while (0);
        if (!find_among_b(z, a_7, 7, 0)) goto lab5;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        among_var = find_among_b(z, a_6, 32, 0);
        if (!among_var) goto lab5;
        if (z->c > z->lb) goto lab5;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_40);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 2, s_41);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab5:
        z->c = z->l - v_6;
    }
    {
        int v_8 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_9, 7, 0)) goto lab7;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 29 || !((-2145255424 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab7;
        if (!find_among_b(z, a_8, 19, 0)) goto lab7;
        if (z->c > z->lb) goto lab7;
        {
            int ret = slice_from_s(z, 1, s_42);
            if (ret < 0) return ret;
        }
    lab7:
        z->c = z->l - v_8;
    }
    {
        int v_9 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_11, 11, 0)) goto lab8;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        among_var = find_among_b(z, a_10, 40, 0);
        if (!among_var) goto lab8;
        if (z->c > z->lb) goto lab8;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_43);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 3, s_44);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab8:
        z->c = z->l - v_9;
    }
    {
        int v_10 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_14, 6, 0)) goto lab9;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_11 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (z->c - 1 <= z->lb || z->p[z->c - 1] != 949) goto lab10;
            among_var = find_among_b(z, a_12, 7, 0);
            if (!among_var) goto lab10;
            if (z->c > z->lb) goto lab10;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 3, s_45);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 1, s_46);
                        if (ret < 0) return ret;
                    }
                    break;
            }
            break;
        lab10:
            z->c = z->l - v_11;
            z->ket = z->c;
            if (z->c - 4 <= z->lb || (z->p[z->c - 1] != 954 && z->p[z->c - 1] != 957)) goto lab9;
            among_var = find_among_b(z, a_13, 10, 0);
            if (!among_var) goto lab9;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 6, s_47);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 4, s_48);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    {
                        int ret = slice_from_s(z, 5, s_49);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    {
                        int ret = slice_from_s(z, 3, s_50);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    {
                        int ret = slice_from_s(z, 6, s_51);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    {
                        int ret = slice_from_s(z, 5, s_52);
                        if (ret < 0) return ret;
                    }
                    break;
                case 7:
                    {
                        int ret = slice_from_s(z, 3, s_53);
                        if (ret < 0) return ret;
                    }
                    break;
                case 8:
                    {
                        int ret = slice_from_s(z, 8, s_54);
                        if (ret < 0) return ret;
                    }
                    break;
                case 9:
                    {
                        int ret = slice_from_s(z, 6, s_55);
                        if (ret < 0) return ret;
                    }
                    break;
                case 10:
                    {
                        int ret = slice_from_s(z, 5, s_56);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        } while (0);
    lab9:
        z->c = z->l - v_10;
    }
    {
        int v_12 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 4 <= z->lb || (z->p[z->c - 1] != 945 && z->p[z->c - 1] != 953)) goto lab11;
        if (!find_among_b(z, a_16, 4, 0)) goto lab11;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (z->c <= z->lb || (z->p[z->c - 1] != 963 && z->p[z->c - 1] != 967)) goto lab11;
        z->c--;
        if (z->c > z->lb) goto lab11;
        {
            int ret = slice_from_s(z, 4, s_57);
            if (ret < 0) return ret;
        }
    lab11:
        z->c = z->l - v_12;
    }
    {
        int v_13 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_18, 8, 0)) goto lab12;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_14 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            among_var = find_among_b(z, a_17, 46, 0);
            if (!among_var) goto lab13;
            if (z->c > z->lb) goto lab13;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 2, s_58);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 3, s_59);
                        if (ret < 0) return ret;
                    }
                    break;
            }
            break;
        lab13:
            z->c = z->l - v_14;
            z->ket = z->c;
            z->bra = z->c;
            if (!(eq_s_b(z, 3, s_60))) goto lab12;
            {
                int ret = slice_from_s(z, 3, s_61);
                if (ret < 0) return ret;
            }
        } while (0);
    lab12:
        z->c = z->l - v_13;
    }
    {
        int v_15 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 3 <= z->lb || z->p[z->c - 1] >> 5 != 29 || !((-1610481664 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab14;
        if (!find_among_b(z, a_21, 3, 0)) goto lab14;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_16 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (!find_among_b(z, a_19, 4, 0)) goto lab15;
            if (z->c > z->lb) goto lab15;
            {
                int ret = slice_from_s(z, 2, s_62);
                if (ret < 0) return ret;
            }
            break;
        lab15:
            z->c = z->l - v_16;
            z->ket = z->c;
            z->bra = z->c;
            if (z->c <= z->lb || (z->p[z->c - 1] != 949 && z->p[z->c - 1] != 957)) goto lab14;
            if (!find_among_b(z, a_20, 2, 0)) goto lab14;
            {
                int ret = slice_from_s(z, 2, s_63);
                if (ret < 0) return ret;
            }
        } while (0);
    lab14:
        z->c = z->l - v_15;
    }
    {
        int v_17 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_23, 4, 0)) goto lab16;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_22, 7, 0)) goto lab16;
        if (z->c > z->lb) goto lab16;
        {
            int ret = slice_from_s(z, 3, s_64);
            if (ret < 0) return ret;
        }
    lab16:
        z->c = z->l - v_17;
    }
    {
        int v_18 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 3 <= z->lb || (z->p[z->c - 1] != 957 && z->p[z->c - 1] != 963)) goto lab17;
        if (!find_among_b(z, a_24, 2, 0)) goto lab17;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        {
            int v_19 = z->l - z->c;
            if (!find_among_b(z, a_25, 10, 0)) goto lab18;
            goto lab17;
        lab18:
            z->c = z->l - v_19;
        }
        {
            int saved_c = z->c;
            int ret = insert_s(z, z->c, z->c, 2, s_65);
            z->c = saved_c;
            if (ret < 0) return ret;
        }
    lab17:
        z->c = z->l - v_18;
    }
    {
        int v_20 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 3 <= z->lb || (z->p[z->c - 1] != 957 && z->p[z->c - 1] != 963)) goto lab19;
        if (!find_among_b(z, a_26, 2, 0)) goto lab19;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        z->ket = z->c;
        z->bra = z->c;
        if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 955 && z->p[z->c - 1] != 960)) goto lab19;
        if (!find_among_b(z, a_27, 8, 0)) goto lab19;
        {
            int ret = slice_from_s(z, 2, s_66);
            if (ret < 0) return ret;
        }
    lab19:
        z->c = z->l - v_20;
    }
    {
        int v_21 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 4 <= z->lb || (z->p[z->c - 1] != 957 && z->p[z->c - 1] != 963)) goto lab20;
        if (!find_among_b(z, a_28, 2, 0)) goto lab20;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_29, 15, 0)) goto lab20;
        {
            int ret = slice_from_s(z, 3, s_67);
            if (ret < 0) return ret;
        }
    lab20:
        z->c = z->l - v_21;
    }
    {
        int v_22 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 2 <= z->lb || (z->p[z->c - 1] != 957 && z->p[z->c - 1] != 963)) goto lab21;
        if (!find_among_b(z, a_30, 2, 0)) goto lab21;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_31, 8, 0)) goto lab21;
        if (z->c > z->lb) goto lab21;
        {
            int ret = slice_from_s(z, 1, s_68);
            if (ret < 0) return ret;
        }
    lab21:
        z->c = z->l - v_22;
    }
    {
        int v_23 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_32, 3, 0)) goto lab22;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (in_grouping_b(z, g_v, 945, 969, 0)) goto lab22;
        {
            int ret = slice_from_s(z, 1, s_69);
            if (ret < 0) return ret;
        }
    lab22:
        z->c = z->l - v_23;
    }
    {
        int v_24 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_33, 4, 0)) goto lab23;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_25 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (in_grouping_b(z, g_v, 945, 969, 0)) goto lab24;
            {
                int ret = slice_from_s(z, 2, s_70);
                if (ret < 0) return ret;
            }
            break;
        lab24:
            z->c = z->l - v_25;
            z->ket = z->c;
        } while (0);
        z->bra = z->c;
        if (!find_among_b(z, a_34, 36, 0)) goto lab23;
        if (z->c > z->lb) goto lab23;
        {
            int ret = slice_from_s(z, 2, s_71);
            if (ret < 0) return ret;
        }
    lab23:
        z->c = z->l - v_24;
    }
    {
        int v_26 = z->l - z->c;
        {
            int v_27 = z->l - z->c;
            z->ket = z->c;
            if (!(eq_s_b(z, 5, s_72))) goto lab26;
            z->bra = z->c;
            if (z->c > z->lb) goto lab26;
            {
                int ret = slice_from_s(z, 4, s_73);
                if (ret < 0) return ret;
            }
        lab26:
            z->c = z->l - v_27;
        }
        {
            int v_28 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 4 <= z->lb || z->p[z->c - 1] != 949) goto lab27;
            if (!find_among_b(z, a_35, 5, 0)) goto lab27;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            b_test1 = 0;
        lab27:
            z->c = z->l - v_28;
        }
        z->ket = z->c;
        if (!(eq_s_b(z, 3, s_74))) goto lab25;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_36, 12, 0)) goto lab25;
        if (z->c > z->lb) goto lab25;
        {
            int ret = slice_from_s(z, 2, s_75);
            if (ret < 0) return ret;
        }
    lab25:
        z->c = z->l - v_26;
    }
    {
        int v_29 = z->l - z->c;
        {
            int v_30 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 4 <= z->lb || z->p[z->c - 1] != 949) goto lab29;
            if (!find_among_b(z, a_38, 11, 0)) goto lab29;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            b_test1 = 0;
            z->ket = z->c;
            z->bra = z->c;
            if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 961 && z->p[z->c - 1] != 963)) goto lab29;
            if (!find_among_b(z, a_37, 2, 0)) goto lab29;
            if (z->c > z->lb) goto lab29;
            {
                int ret = slice_from_s(z, 4, s_76);
                if (ret < 0) return ret;
            }
        lab29:
            z->c = z->l - v_30;
        }
        z->ket = z->c;
        if (!(eq_s_b(z, 3, s_77))) goto lab28;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_31 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (in_grouping_b(z, g_v2, 945, 969, 0)) goto lab30;
            {
                int ret = slice_from_s(z, 2, s_78);
                if (ret < 0) return ret;
            }
            break;
        lab30:
            z->c = z->l - v_31;
            z->ket = z->c;
        } while (0);
        z->bra = z->c;
        if (!find_among_b(z, a_39, 95, 0)) goto lab28;
        if (z->c > z->lb) goto lab28;
        {
            int ret = slice_from_s(z, 2, s_79);
            if (ret < 0) return ret;
        }
    lab28:
        z->c = z->l - v_29;
    }
    {
        int v_32 = z->l - z->c;
        {
            int v_33 = z->l - z->c;
            z->ket = z->c;
            if (!(eq_s_b(z, 5, s_80))) goto lab32;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            b_test1 = 0;
        lab32:
            z->c = z->l - v_33;
        }
        z->ket = z->c;
        if (!(eq_s_b(z, 3, s_81))) goto lab31;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_34 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (in_grouping_b(z, g_v2, 945, 969, 0)) goto lab33;
            {
                int ret = slice_from_s(z, 2, s_82);
                if (ret < 0) return ret;
            }
            break;
        lab33:
            z->c = z->l - v_34;
            z->ket = z->c;
            z->bra = z->c;
            if (!find_among_b(z, a_40, 31, 0)) goto lab34;
            {
                int ret = slice_from_s(z, 2, s_83);
                if (ret < 0) return ret;
            }
            break;
        lab34:
            z->c = z->l - v_34;
            z->ket = z->c;
        } while (0);
        z->bra = z->c;
        if (!find_among_b(z, a_41, 25, 0)) goto lab31;
        if (z->c > z->lb) goto lab31;
        {
            int ret = slice_from_s(z, 2, s_84);
            if (ret < 0) return ret;
        }
    lab31:
        z->c = z->l - v_32;
    }
    {
        int v_35 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 4 <= z->lb || z->p[z->c - 1] != 963) goto lab35;
        if (!find_among_b(z, a_42, 2, 0)) goto lab35;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_36 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (!(eq_s_b(z, 3, s_85))) goto lab36;
            if (z->c > z->lb) goto lab36;
            {
                int ret = slice_from_s(z, 3, s_86);
                if (ret < 0) return ret;
            }
            break;
        lab36:
            z->c = z->l - v_36;
            z->ket = z->c;
            z->bra = z->c;
            if (!(eq_s_b(z, 3, s_87))) goto lab35;
            {
                int ret = slice_from_s(z, 3, s_88);
                if (ret < 0) return ret;
            }
        } while (0);
    lab35:
        z->c = z->l - v_35;
    }
    {
        int v_37 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 5 <= z->lb || z->p[z->c - 1] != 949) goto lab37;
        if (!find_among_b(z, a_43, 2, 0)) goto lab37;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!(eq_s_b(z, 2, s_89))) goto lab37;
        if (z->c > z->lb) goto lab37;
        {
            int ret = slice_from_s(z, 5, s_90);
            if (ret < 0) return ret;
        }
    lab37:
        z->c = z->l - v_37;
    }
    {
        int v_38 = z->l - z->c;
        {
            int v_39 = z->l - z->c;
            z->ket = z->c;
            if (!(eq_s_b(z, 5, s_91))) goto lab39;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            b_test1 = 0;
            z->ket = z->c;
            z->bra = z->c;
            if (z->c <= z->lb || (z->p[z->c - 1] != 960 && z->p[z->c - 1] != 966)) goto lab39;
            if (!find_among_b(z, a_44, 6, 0)) goto lab39;
            if (z->c > z->lb) goto lab39;
            {
                int ret = slice_from_s(z, 4, s_92);
                if (ret < 0) return ret;
            }
        lab39:
            z->c = z->l - v_39;
        }
        z->ket = z->c;
        if (!(eq_s_b(z, 4, s_93))) goto lab38;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_45, 9, 0)) goto lab38;
        if (z->c > z->lb) goto lab38;
        {
            int ret = slice_from_s(z, 4, s_94);
            if (ret < 0) return ret;
        }
    lab38:
        z->c = z->l - v_38;
    }
    {
        int v_40 = z->l - z->c;
        {
            int v_41 = z->l - z->c;
            z->ket = z->c;
            if (!find_among_b(z, a_46, 3, 0)) goto lab41;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            b_test1 = 0;
        lab41:
            z->c = z->l - v_41;
        }
        z->ket = z->c;
        if (!find_among_b(z, a_49, 3, 0)) goto lab40;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_42 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (!find_among_b(z, a_47, 6, 0)) goto lab42;
            {
                int ret = slice_from_s(z, 2, s_95);
                if (ret < 0) return ret;
            }
            break;
        lab42:
            z->c = z->l - v_42;
            z->ket = z->c;
            z->bra = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 952) goto lab40;
            if (!find_among_b(z, a_48, 5, 0)) goto lab40;
            if (z->c > z->lb) goto lab40;
            {
                int ret = slice_from_s(z, 2, s_96);
                if (ret < 0) return ret;
            }
        } while (0);
    lab40:
        z->c = z->l - v_40;
    }
    {
        int v_43 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_52, 3, 0)) goto lab43;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_44 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (!find_among_b(z, a_50, 12, 0)) goto lab44;
            {
                int ret = slice_from_s(z, 3, s_97);
                if (ret < 0) return ret;
            }
            break;
        lab44:
            z->c = z->l - v_44;
            z->ket = z->c;
            z->bra = z->c;
            if (!find_among_b(z, a_51, 25, 0)) goto lab43;
            if (z->c > z->lb) goto lab43;
            {
                int ret = slice_from_s(z, 3, s_98);
                if (ret < 0) return ret;
            }
        } while (0);
    lab43:
        z->c = z->l - v_43;
    }
    {
        int v_45 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_56, 3, 0)) goto lab45;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] != 957) goto lab45;
        if (!find_among_b(z, a_57, 6, 0)) goto lab45;
        if (z->c > z->lb) goto lab45;
        {
            int ret = slice_from_s(z, 2, s_99);
            if (ret < 0) return ret;
        }
    lab45:
        z->c = z->l - v_45;
    }
    {
        int v_46 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_55, 3, 0)) goto lab46;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        do {
            int v_47 = z->l - z->c;
            z->ket = z->c;
            z->bra = z->c;
            if (!(eq_s_b(z, 4, s_100))) goto lab47;
            {
                int ret = slice_from_s(z, 2, s_101);
                if (ret < 0) return ret;
            }
            break;
        lab47:
            z->c = z->l - v_47;
            do {
                int v_48 = z->l - z->c;
                z->ket = z->c;
                z->bra = z->c;
                among_var = find_among_b(z, a_53, 12, 0);
                if (!among_var) goto lab48;
                switch (among_var) {
                    case 1:
                        {
                            int ret = slice_from_s(z, 2, s_102);
                            if (ret < 0) return ret;
                        }
                        break;
                }
                break;
            lab48:
                z->c = z->l - v_48;
                z->ket = z->c;
                z->bra = z->c;
                if (!find_among_b(z, a_54, 44, 0)) goto lab46;
                if (z->c > z->lb) goto lab46;
                {
                    int ret = slice_from_s(z, 2, s_103);
                    if (ret < 0) return ret;
                }
            } while (0);
        } while (0);
    lab46:
        z->c = z->l - v_46;
    }
    {
        int v_49 = z->l - z->c;
        z->ket = z->c;
        if (!(eq_s_b(z, 4, s_104))) goto lab49;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_58, 10, 0)) goto lab49;
        if (z->c > z->lb) goto lab49;
        {
            int ret = slice_from_s(z, 3, s_105);
            if (ret < 0) return ret;
        }
    lab49:
        z->c = z->l - v_49;
    }
    {
        int v_50 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 3 <= z->lb || z->p[z->c - 1] != 949) goto lab50;
        if (!find_among_b(z, a_59, 3, 0)) goto lab50;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_60, 6, 0)) goto lab50;
        if (z->c > z->lb) goto lab50;
        {
            int ret = slice_from_s(z, 3, s_106);
            if (ret < 0) return ret;
        }
    lab50:
        z->c = z->l - v_50;
    }
    {
        int v_51 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 3 <= z->lb || z->p[z->c - 1] != 949) goto lab51;
        if (!find_among_b(z, a_61, 3, 0)) goto lab51;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_test1 = 0;
        z->ket = z->c;
        z->bra = z->c;
        if (!find_among_b(z, a_62, 7, 0)) goto lab51;
        if (z->c > z->lb) goto lab51;
        {
            int ret = slice_from_s(z, 3, s_107);
            if (ret < 0) return ret;
        }
    lab51:
        z->c = z->l - v_51;
    }
    {
        int v_52 = z->l - z->c;
        {
            int v_53 = z->l - z->c;
            z->ket = z->c;
            if (!find_among_b(z, a_63, 3, 0)) goto lab53;
            z->bra = z->c;
            {
                int ret = slice_from_s(z, 2, s_108);
                if (ret < 0) return ret;
            }
        lab53:
            z->c = z->l - v_53;
        }
        if (!b_test1) goto lab52;
        z->ket = z->c;
        if (!find_among_b(z, a_64, 84, 0)) goto lab52;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab52:
        z->c = z->l - v_52;
    }
    {
        int v_54 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 3 <= z->lb || (z->p[z->c - 1] != 961 && z->p[z->c - 1] != 964)) goto lab54;
        if (!find_among_b(z, a_65, 8, 0)) goto lab54;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab54:
        z->c = z->l - v_54;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * greek_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
