/*
 * Generated from algorithms/tamil.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "tamil_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

struct SN_local {
    struct SN_env z;
    unsigned char b_found_vetrumai_urupu;
};

typedef struct SN_local SN_local;

#ifdef __cplusplus
extern "C" {
#endif
extern int tamil_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_fix_endings(struct SN_env * z);
static int r_fix_ending(struct SN_env * z);
static int r_fix_va_start(struct SN_env * z);

static const symbol s_0[] = { 0xB93 };
static const symbol s_1[] = { 0xB92 };
static const symbol s_2[] = { 0xB89 };
static const symbol s_3[] = { 0xB8A };
static const symbol s_4[] = { 0xBB3, 0xBCD };
static const symbol s_5[] = { 0xBB2, 0xBCD };
static const symbol s_6[] = { 0xB9F, 0xBC1 };
static const symbol s_7[] = { 0xBAE, 0xBCD };
static const symbol s_8[] = { 0xBCD };
static const symbol s_9[] = { 0xBAE, 0xBCD };
static const symbol s_10[] = { 0xBCD };
static const symbol s_11[] = { 0xBC1, 0xBAE, 0xBCD };
static const symbol s_12[] = { 0xBCD };
static const symbol s_13[] = { 0xBCD };
static const symbol s_14[] = { 0xBCD };
static const symbol s_15[] = { 0xBCD };
static const symbol s_16[] = { 0xBCD };
static const symbol s_17[] = { 0xBCD };
static const symbol s_18[] = { 0xBCD };
static const symbol s_19[] = { 0xBBF };
static const symbol s_20[] = { 0xBCD };
static const symbol s_21[] = { 0xBBF, 0xBA9, 0xBCD };
static const symbol s_22[] = { 0xBCD };
static const symbol s_23[] = { 0xBC1, 0xB99, 0xBCD };
static const symbol s_24[] = { 0xBCD };
static const symbol s_25[] = { 0xBB2, 0xBCD };
static const symbol s_26[] = { 0xBB3, 0xBCD };
static const symbol s_27[] = { 0xBCD };
static const symbol s_28[] = { 0xBCD };

static const symbol s_0_0[2] = { 0xBB5, 0xBC1 };
static const symbol s_0_1[2] = { 0xBB5, 0xBC2 };
static const symbol s_0_2[2] = { 0xBB5, 0xBCA };
static const symbol s_0_3[2] = { 0xBB5, 0xBCB };
static const struct among a_0[4] = {
{ 2, s_0_0, 0, 3, 0},
{ 2, s_0_1, 0, 4, 0},
{ 2, s_0_2, 0, 2, 0},
{ 2, s_0_3, 0, 1, 0}
};

static const symbol s_1_0[1] = { 0xB95 };
static const symbol s_1_1[1] = { 0xB99 };
static const symbol s_1_2[1] = { 0xB9A };
static const symbol s_1_3[1] = { 0xB9E };
static const symbol s_1_4[1] = { 0xBA4 };
static const symbol s_1_5[1] = { 0xBA8 };
static const symbol s_1_6[1] = { 0xBAA };
static const symbol s_1_7[1] = { 0xBAE };
static const symbol s_1_8[1] = { 0xBAF };
static const symbol s_1_9[1] = { 0xBB5 };
static const struct among a_1[10] = {
{ 1, s_1_0, 0, -1, 0},
{ 1, s_1_1, 0, -1, 0},
{ 1, s_1_2, 0, -1, 0},
{ 1, s_1_3, 0, -1, 0},
{ 1, s_1_4, 0, -1, 0},
{ 1, s_1_5, 0, -1, 0},
{ 1, s_1_6, 0, -1, 0},
{ 1, s_1_7, 0, -1, 0},
{ 1, s_1_8, 0, -1, 0},
{ 1, s_1_9, 0, -1, 0}
};

static const symbol s_2_0[1] = { 0xBBF };
static const symbol s_2_1[1] = { 0xBC0 };
static const symbol s_2_2[1] = { 0xBC8 };
static const struct among a_2[3] = {
{ 1, s_2_0, 0, -1, 0},
{ 1, s_2_1, 0, -1, 0},
{ 1, s_2_2, 0, -1, 0}
};

static const symbol s_3_0[1] = { 0xBBE };
static const symbol s_3_1[1] = { 0xBBF };
static const symbol s_3_2[1] = { 0xBC0 };
static const symbol s_3_3[1] = { 0xBC1 };
static const symbol s_3_4[1] = { 0xBC2 };
static const symbol s_3_5[1] = { 0xBC6 };
static const symbol s_3_6[1] = { 0xBC7 };
static const symbol s_3_7[1] = { 0xBC8 };
static const struct among a_3[8] = {
{ 1, s_3_0, 0, -1, 0},
{ 1, s_3_1, 0, -1, 0},
{ 1, s_3_2, 0, -1, 0},
{ 1, s_3_3, 0, -1, 0},
{ 1, s_3_4, 0, -1, 0},
{ 1, s_3_5, 0, -1, 0},
{ 1, s_3_6, 0, -1, 0},
{ 1, s_3_7, 0, -1, 0}
};

static const symbol s_4_1[1] = { 0xBC8 };
static const symbol s_4_2[1] = { 0xBCD };
static const struct among a_4[3] = {
{ 0, 0, 0, 2, 0},
{ 1, s_4_1, -1, 1, 0},
{ 1, s_4_2, -2, 1, 0}
};

static const symbol s_5_0[3] = { 0xBA8, 0xBCD, 0xBA4 };
static const symbol s_5_1[1] = { 0xBAF };
static const symbol s_5_2[1] = { 0xBB5 };
static const symbol s_5_3[2] = { 0xBA9, 0xBC1 };
static const symbol s_5_4[3] = { 0xBC1, 0xB95, 0xBCD };
static const symbol s_5_5[5] = { 0xBC1, 0xB95, 0xBCD, 0xB95, 0xBCD };
static const symbol s_5_6[4] = { 0xB9F, 0xBCD, 0xB95, 0xBCD };
static const symbol s_5_7[4] = { 0xBB1, 0xBCD, 0xB95, 0xBCD };
static const symbol s_5_8[2] = { 0xB99, 0xBCD };
static const symbol s_5_9[4] = { 0xB9F, 0xBCD, 0xB9F, 0xBCD };
static const symbol s_5_10[4] = { 0xBA4, 0xBCD, 0xBA4, 0xBCD };
static const symbol s_5_11[4] = { 0xBA8, 0xBCD, 0xBA4, 0xBCD };
static const symbol s_5_12[2] = { 0xBA8, 0xBCD };
static const symbol s_5_13[4] = { 0xB9F, 0xBCD, 0xBAA, 0xBCD };
static const symbol s_5_14[2] = { 0xBAF, 0xBCD };
static const symbol s_5_15[4] = { 0xBA9, 0xBCD, 0xBB1, 0xBCD };
static const symbol s_5_16[2] = { 0xBB5, 0xBCD };
static const struct among a_5[17] = {
{ 3, s_5_0, 0, 1, 0},
{ 1, s_5_1, 0, 1, 0},
{ 1, s_5_2, 0, 1, 0},
{ 2, s_5_3, 0, 8, 0},
{ 3, s_5_4, 0, 7, 0},
{ 5, s_5_5, 0, 7, 0},
{ 4, s_5_6, 0, 3, 0},
{ 4, s_5_7, 0, 4, 0},
{ 2, s_5_8, 0, 9, 0},
{ 4, s_5_9, 0, 5, 0},
{ 4, s_5_10, 0, 6, 0},
{ 4, s_5_11, 0, 1, 0},
{ 2, s_5_12, 0, 1, 0},
{ 4, s_5_13, 0, 3, 0},
{ 2, s_5_14, 0, 2, 0},
{ 4, s_5_15, 0, 4, 0},
{ 2, s_5_16, 0, 1, 0}
};

static const symbol s_6_0[1] = { 0xB95 };
static const symbol s_6_1[1] = { 0xB9A };
static const symbol s_6_2[1] = { 0xB9F };
static const symbol s_6_3[1] = { 0xBA4 };
static const symbol s_6_4[1] = { 0xBAA };
static const symbol s_6_5[1] = { 0xBB1 };
static const struct among a_6[6] = {
{ 1, s_6_0, 0, -1, 0},
{ 1, s_6_1, 0, -1, 0},
{ 1, s_6_2, 0, -1, 0},
{ 1, s_6_3, 0, -1, 0},
{ 1, s_6_4, 0, -1, 0},
{ 1, s_6_5, 0, -1, 0}
};

static const symbol s_7_0[1] = { 0xB95 };
static const symbol s_7_1[1] = { 0xB9A };
static const symbol s_7_2[1] = { 0xB9F };
static const symbol s_7_3[1] = { 0xBA4 };
static const symbol s_7_4[1] = { 0xBAA };
static const symbol s_7_5[1] = { 0xBB1 };
static const struct among a_7[6] = {
{ 1, s_7_0, 0, -1, 0},
{ 1, s_7_1, 0, -1, 0},
{ 1, s_7_2, 0, -1, 0},
{ 1, s_7_3, 0, -1, 0},
{ 1, s_7_4, 0, -1, 0},
{ 1, s_7_5, 0, -1, 0}
};

static const symbol s_8_0[1] = { 0xB9E };
static const symbol s_8_1[1] = { 0xBA3 };
static const symbol s_8_2[1] = { 0xBA8 };
static const symbol s_8_3[1] = { 0xBA9 };
static const symbol s_8_4[1] = { 0xBAE };
static const symbol s_8_5[1] = { 0xBAF };
static const symbol s_8_6[1] = { 0xBB0 };
static const symbol s_8_7[1] = { 0xBB2 };
static const symbol s_8_8[1] = { 0xBB3 };
static const symbol s_8_9[1] = { 0xBB4 };
static const symbol s_8_10[1] = { 0xBB5 };
static const struct among a_8[11] = {
{ 1, s_8_0, 0, -1, 0},
{ 1, s_8_1, 0, -1, 0},
{ 1, s_8_2, 0, -1, 0},
{ 1, s_8_3, 0, -1, 0},
{ 1, s_8_4, 0, -1, 0},
{ 1, s_8_5, 0, -1, 0},
{ 1, s_8_6, 0, -1, 0},
{ 1, s_8_7, 0, -1, 0},
{ 1, s_8_8, 0, -1, 0},
{ 1, s_8_9, 0, -1, 0},
{ 1, s_8_10, 0, -1, 0}
};

static const symbol s_9_0[1] = { 0xBBE };
static const symbol s_9_1[1] = { 0xBBF };
static const symbol s_9_2[1] = { 0xBC0 };
static const symbol s_9_3[1] = { 0xBC1 };
static const symbol s_9_4[1] = { 0xBC2 };
static const symbol s_9_5[1] = { 0xBC6 };
static const symbol s_9_6[1] = { 0xBC7 };
static const symbol s_9_7[1] = { 0xBC8 };
static const symbol s_9_8[1] = { 0xBCD };
static const struct among a_9[9] = {
{ 1, s_9_0, 0, -1, 0},
{ 1, s_9_1, 0, -1, 0},
{ 1, s_9_2, 0, -1, 0},
{ 1, s_9_3, 0, -1, 0},
{ 1, s_9_4, 0, -1, 0},
{ 1, s_9_5, 0, -1, 0},
{ 1, s_9_6, 0, -1, 0},
{ 1, s_9_7, 0, -1, 0},
{ 1, s_9_8, 0, -1, 0}
};

static const symbol s_11_0[1] = { 0xB95 };
static const symbol s_11_1[1] = { 0xB99 };
static const symbol s_11_2[1] = { 0xB9A };
static const symbol s_11_3[1] = { 0xB9E };
static const symbol s_11_4[1] = { 0xBA4 };
static const symbol s_11_5[1] = { 0xBA8 };
static const symbol s_11_6[1] = { 0xBAA };
static const symbol s_11_7[1] = { 0xBAE };
static const symbol s_11_8[1] = { 0xBAF };
static const symbol s_11_9[1] = { 0xBB5 };
static const struct among a_11[10] = {
{ 1, s_11_0, 0, -1, 0},
{ 1, s_11_1, 0, -1, 0},
{ 1, s_11_2, 0, -1, 0},
{ 1, s_11_3, 0, -1, 0},
{ 1, s_11_4, 0, -1, 0},
{ 1, s_11_5, 0, -1, 0},
{ 1, s_11_6, 0, -1, 0},
{ 1, s_11_7, 0, -1, 0},
{ 1, s_11_8, 0, -1, 0},
{ 1, s_11_9, 0, -1, 0}
};

static const symbol s_12_0[1] = { 0xB95 };
static const symbol s_12_1[1] = { 0xB9A };
static const symbol s_12_2[1] = { 0xB9F };
static const symbol s_12_3[1] = { 0xBA4 };
static const symbol s_12_4[1] = { 0xBAA };
static const symbol s_12_5[1] = { 0xBB1 };
static const struct among a_12[6] = {
{ 1, s_12_0, 0, -1, 0},
{ 1, s_12_1, 0, -1, 0},
{ 1, s_12_2, 0, -1, 0},
{ 1, s_12_3, 0, -1, 0},
{ 1, s_12_4, 0, -1, 0},
{ 1, s_12_5, 0, -1, 0}
};

static const symbol s_13_0[3] = { 0xB95, 0xBB3, 0xBCD };
static const symbol s_13_1[6] = { 0xBC1, 0xB99, 0xBCD, 0xB95, 0xBB3, 0xBCD };
static const symbol s_13_2[5] = { 0xB9F, 0xBCD, 0xB95, 0xBB3, 0xBCD };
static const symbol s_13_3[5] = { 0xBB1, 0xBCD, 0xB95, 0xBB3, 0xBCD };
static const struct among a_13[4] = {
{ 3, s_13_0, 0, 4, 0},
{ 6, s_13_1, -1, 1, 0},
{ 5, s_13_2, -2, 3, 0},
{ 5, s_13_3, -3, 2, 0}
};

static const symbol s_14_0[1] = { 0xBBE };
static const symbol s_14_1[1] = { 0xBC7 };
static const symbol s_14_2[1] = { 0xBCB };
static const struct among a_14[3] = {
{ 1, s_14_0, 0, -1, 0},
{ 1, s_14_1, 0, -1, 0},
{ 1, s_14_2, 0, -1, 0}
};

static const symbol s_15_0[2] = { 0xBAA, 0xBBF };
static const symbol s_15_1[2] = { 0xBB5, 0xBBF };
static const struct among a_15[2] = {
{ 2, s_15_0, 0, -1, 0},
{ 2, s_15_1, 0, -1, 0}
};

static const symbol s_16_0[1] = { 0xBBE };
static const symbol s_16_1[1] = { 0xBBF };
static const symbol s_16_2[1] = { 0xBC0 };
static const symbol s_16_3[1] = { 0xBC1 };
static const symbol s_16_4[1] = { 0xBC2 };
static const symbol s_16_5[1] = { 0xBC6 };
static const symbol s_16_6[1] = { 0xBC7 };
static const symbol s_16_7[1] = { 0xBC8 };
static const struct among a_16[8] = {
{ 1, s_16_0, 0, -1, 0},
{ 1, s_16_1, 0, -1, 0},
{ 1, s_16_2, 0, -1, 0},
{ 1, s_16_3, 0, -1, 0},
{ 1, s_16_4, 0, -1, 0},
{ 1, s_16_5, 0, -1, 0},
{ 1, s_16_6, 0, -1, 0},
{ 1, s_16_7, 0, -1, 0}
};

static const symbol s_17_0[4] = { 0xBAA, 0xB9F, 0xBCD, 0xB9F };
static const symbol s_17_1[5] = { 0xBAA, 0xB9F, 0xBCD, 0xB9F, 0xBA3 };
static const symbol s_17_2[3] = { 0xBA4, 0xBBE, 0xBA9 };
static const symbol s_17_3[6] = { 0xBAA, 0xB9F, 0xBBF, 0xBA4, 0xBBE, 0xBA9 };
static const symbol s_17_4[2] = { 0xBC6, 0xBA9 };
static const symbol s_17_5[4] = { 0xBBE, 0xB95, 0xBBF, 0xBAF };
static const symbol s_17_6[5] = { 0xB95, 0xBC1, 0xBB0, 0xBBF, 0xBAF };
static const symbol s_17_7[4] = { 0xBC1, 0xB9F, 0xBC8, 0xBAF };
static const symbol s_17_8[3] = { 0xBB2, 0xBCD, 0xBB2 };
static const symbol s_17_9[4] = { 0xBC1, 0xBB3, 0xBCD, 0xBB3 };
static const symbol s_17_10[3] = { 0xBBE, 0xB95, 0xBBF };
static const symbol s_17_11[3] = { 0xBAA, 0xB9F, 0xBBF };
static const symbol s_17_12[5] = { 0xBBF, 0xBA9, 0xBCD, 0xBB1, 0xBBF };
static const symbol s_17_13[5] = { 0xBAA, 0xBB1, 0xBCD, 0xBB1, 0xBBF };
static const symbol s_17_14[3] = { 0xBAA, 0xB9F, 0xBC1 };
static const symbol s_17_15[4] = { 0xBB5, 0xBBF, 0xB9F, 0xBC1 };
static const symbol s_17_16[5] = { 0xBAA, 0xB9F, 0xBCD, 0xB9F, 0xBC1 };
static const symbol s_17_17[6] = { 0xBB5, 0xBBF, 0xB9F, 0xBCD, 0xB9F, 0xBC1 };
static const symbol s_17_18[6] = { 0xBAA, 0xB9F, 0xBCD, 0xB9F, 0xBA4, 0xBC1 };
static const symbol s_17_19[5] = { 0xBC6, 0xBA9, 0xBCD, 0xBB1, 0xBC1 };
static const symbol s_17_20[3] = { 0xBC1, 0xB9F, 0xBC8 };
static const symbol s_17_21[5] = { 0xBBF, 0xBB2, 0xBCD, 0xBB2, 0xBC8 };
static const symbol s_17_22[4] = { 0xBC1, 0xB9F, 0xBA9, 0xBCD };
static const symbol s_17_23[4] = { 0xBBF, 0xB9F, 0xBAE, 0xBCD };
static const symbol s_17_24[7] = { 0xBC6, 0xBB2, 0xBCD, 0xBB2, 0xBBE, 0xBAE, 0xBCD };
static const symbol s_17_25[5] = { 0xBC6, 0xBA9, 0xBC1, 0xBAE, 0xBCD };
static const struct among a_17[26] = {
{ 4, s_17_0, 0, 3, 0},
{ 5, s_17_1, 0, 3, 0},
{ 3, s_17_2, 0, 3, 0},
{ 6, s_17_3, -1, 3, 0},
{ 2, s_17_4, 0, 1, 0},
{ 4, s_17_5, 0, 1, 0},
{ 5, s_17_6, 0, 3, 0},
{ 4, s_17_7, 0, 1, 0},
{ 3, s_17_8, 0, 2, 0},
{ 4, s_17_9, 0, 1, 0},
{ 3, s_17_10, 0, 1, 0},
{ 3, s_17_11, 0, 3, 0},
{ 5, s_17_12, 0, 1, 0},
{ 5, s_17_13, 0, 3, 0},
{ 3, s_17_14, 0, 3, 0},
{ 4, s_17_15, 0, 3, 0},
{ 5, s_17_16, 0, 3, 0},
{ 6, s_17_17, 0, 3, 0},
{ 6, s_17_18, 0, 3, 0},
{ 5, s_17_19, 0, 1, 0},
{ 3, s_17_20, 0, 1, 0},
{ 5, s_17_21, 0, 1, 0},
{ 4, s_17_22, 0, 1, 0},
{ 4, s_17_23, 0, 1, 0},
{ 7, s_17_24, 0, 3, 0},
{ 5, s_17_25, 0, 1, 0}
};

static const symbol s_18_0[1] = { 0xBBE };
static const symbol s_18_1[1] = { 0xBBF };
static const symbol s_18_2[1] = { 0xBC0 };
static const symbol s_18_3[1] = { 0xBC1 };
static const symbol s_18_4[1] = { 0xBC2 };
static const symbol s_18_5[1] = { 0xBC6 };
static const symbol s_18_6[1] = { 0xBC7 };
static const symbol s_18_7[1] = { 0xBC8 };
static const struct among a_18[8] = {
{ 1, s_18_0, 0, -1, 0},
{ 1, s_18_1, 0, -1, 0},
{ 1, s_18_2, 0, -1, 0},
{ 1, s_18_3, 0, -1, 0},
{ 1, s_18_4, 0, -1, 0},
{ 1, s_18_5, 0, -1, 0},
{ 1, s_18_6, 0, -1, 0},
{ 1, s_18_7, 0, -1, 0}
};

static const symbol s_19_0[1] = { 0xBBE };
static const symbol s_19_1[1] = { 0xBBF };
static const symbol s_19_2[1] = { 0xBC0 };
static const symbol s_19_3[1] = { 0xBC1 };
static const symbol s_19_4[1] = { 0xBC2 };
static const symbol s_19_5[1] = { 0xBC6 };
static const symbol s_19_6[1] = { 0xBC7 };
static const symbol s_19_7[1] = { 0xBC8 };
static const struct among a_19[8] = {
{ 1, s_19_0, 0, -1, 0},
{ 1, s_19_1, 0, -1, 0},
{ 1, s_19_2, 0, -1, 0},
{ 1, s_19_3, 0, -1, 0},
{ 1, s_19_4, 0, -1, 0},
{ 1, s_19_5, 0, -1, 0},
{ 1, s_19_6, 0, -1, 0},
{ 1, s_19_7, 0, -1, 0}
};

static const symbol s_20_0[3] = { 0xBB5, 0xBBF, 0xB9F };
static const symbol s_20_1[1] = { 0xBC0 };
static const symbol s_20_2[3] = { 0xBCA, 0xB9F, 0xBC1 };
static const symbol s_20_3[3] = { 0xBCB, 0xB9F, 0xBC1 };
static const symbol s_20_4[2] = { 0xBA4, 0xBC1 };
static const symbol s_20_5[7] = { 0xBBF, 0xBB0, 0xBC1, 0xBA8, 0xBCD, 0xBA4, 0xBC1 };
static const symbol s_20_6[5] = { 0xBBF, 0xBA9, 0xBCD, 0xBB1, 0xBC1 };
static const symbol s_20_7[3] = { 0xBC1, 0xB9F, 0xBC8 };
static const symbol s_20_8[2] = { 0xBA9, 0xBC8 };
static const symbol s_20_9[3] = { 0xB95, 0xBA3, 0xBCD };
static const symbol s_20_10[3] = { 0xBBF, 0xBA9, 0xBCD };
static const symbol s_20_11[4] = { 0xBAE, 0xBC1, 0xBA9, 0xBCD };
static const symbol s_20_12[4] = { 0xBBF, 0xB9F, 0xBAE, 0xBCD };
static const symbol s_20_13[3] = { 0xBBF, 0xBB1, 0xBCD };
static const symbol s_20_14[4] = { 0xBAE, 0xBC7, 0xBB1, 0xBCD };
static const symbol s_20_15[2] = { 0xBB2, 0xBCD };
static const symbol s_20_16[4] = { 0xBBE, 0xBAE, 0xBB2, 0xBCD };
static const symbol s_20_17[3] = { 0xBBE, 0xBB2, 0xBCD };
static const symbol s_20_18[3] = { 0xBBF, 0xBB2, 0xBCD };
static const symbol s_20_19[4] = { 0xBAE, 0xBC7, 0xBB2, 0xBCD };
static const symbol s_20_20[3] = { 0xBC1, 0xBB3, 0xBCD };
static const symbol s_20_21[4] = { 0xB95, 0xBC0, 0xBB4, 0xBCD };
static const struct among a_20[22] = {
{ 3, s_20_0, 0, 2, 0},
{ 1, s_20_1, 0, 7, 0},
{ 3, s_20_2, 0, 2, 0},
{ 3, s_20_3, 0, 2, 0},
{ 2, s_20_4, 0, 6, 0},
{ 7, s_20_5, -1, 2, 0},
{ 5, s_20_6, 0, 2, 0},
{ 3, s_20_7, 0, 2, 0},
{ 2, s_20_8, 0, 1, 0},
{ 3, s_20_9, 0, 1, 0},
{ 3, s_20_10, 0, 3, 0},
{ 4, s_20_11, 0, 1, 0},
{ 4, s_20_12, 0, 4, 0},
{ 3, s_20_13, 0, 2, 0},
{ 4, s_20_14, 0, 1, 0},
{ 2, s_20_15, 0, 5, 0},
{ 4, s_20_16, -1, 2, 0},
{ 3, s_20_17, -2, 2, 0},
{ 3, s_20_18, -3, 2, 0},
{ 4, s_20_19, -4, 1, 0},
{ 3, s_20_20, 0, 2, 0},
{ 4, s_20_21, 0, 1, 0}
};

static const symbol s_21_0[1] = { 0xB95 };
static const symbol s_21_1[1] = { 0xB9A };
static const symbol s_21_2[1] = { 0xB9F };
static const symbol s_21_3[1] = { 0xBA4 };
static const symbol s_21_4[1] = { 0xBAA };
static const symbol s_21_5[1] = { 0xBB1 };
static const struct among a_21[6] = {
{ 1, s_21_0, 0, -1, 0},
{ 1, s_21_1, 0, -1, 0},
{ 1, s_21_2, 0, -1, 0},
{ 1, s_21_3, 0, -1, 0},
{ 1, s_21_4, 0, -1, 0},
{ 1, s_21_5, 0, -1, 0}
};

static const symbol s_22_0[1] = { 0xB95 };
static const symbol s_22_1[1] = { 0xB9A };
static const symbol s_22_2[1] = { 0xB9F };
static const symbol s_22_3[1] = { 0xBA4 };
static const symbol s_22_4[1] = { 0xBAA };
static const symbol s_22_5[1] = { 0xBB1 };
static const struct among a_22[6] = {
{ 1, s_22_0, 0, -1, 0},
{ 1, s_22_1, 0, -1, 0},
{ 1, s_22_2, 0, -1, 0},
{ 1, s_22_3, 0, -1, 0},
{ 1, s_22_4, 0, -1, 0},
{ 1, s_22_5, 0, -1, 0}
};

static const symbol s_24_0[1] = { 0xBBE };
static const symbol s_24_1[1] = { 0xBBF };
static const symbol s_24_2[1] = { 0xBC0 };
static const symbol s_24_3[1] = { 0xBC1 };
static const symbol s_24_4[1] = { 0xBC2 };
static const symbol s_24_5[1] = { 0xBC6 };
static const symbol s_24_6[1] = { 0xBC7 };
static const symbol s_24_7[1] = { 0xBC8 };
static const struct among a_24[8] = {
{ 1, s_24_0, 0, -1, 0},
{ 1, s_24_1, 0, -1, 0},
{ 1, s_24_2, 0, -1, 0},
{ 1, s_24_3, 0, -1, 0},
{ 1, s_24_4, 0, -1, 0},
{ 1, s_24_5, 0, -1, 0},
{ 1, s_24_6, 0, -1, 0},
{ 1, s_24_7, 0, -1, 0}
};

static const symbol s_25_0[1] = { 0xB95 };
static const symbol s_25_1[1] = { 0xBA4 };
static const symbol s_25_2[1] = { 0xBA9 };
static const symbol s_25_3[1] = { 0xBAA };
static const symbol s_25_4[1] = { 0xBAF };
static const symbol s_25_5[1] = { 0xBBE };
static const symbol s_25_6[2] = { 0xB95, 0xBC1 };
static const symbol s_25_7[3] = { 0xBAA, 0xB9F, 0xBC1 };
static const symbol s_25_8[2] = { 0xBA4, 0xBC1 };
static const symbol s_25_9[5] = { 0xBBF, 0xBB1, 0xBCD, 0xBB1, 0xBC1 };
static const symbol s_25_10[2] = { 0xBA9, 0xBC8 };
static const symbol s_25_11[2] = { 0xBB5, 0xBC8 };
static const symbol s_25_12[3] = { 0xBA9, 0xBA9, 0xBCD };
static const symbol s_25_13[3] = { 0xBAA, 0xBA9, 0xBCD };
static const symbol s_25_14[3] = { 0xBB5, 0xBA9, 0xBCD };
static const symbol s_25_15[3] = { 0xBBE, 0xBA9, 0xBCD };
static const symbol s_25_16[4] = { 0xBA9, 0xBBE, 0xBA9, 0xBCD };
static const symbol s_25_17[4] = { 0xBAE, 0xBBF, 0xBA9, 0xBCD };
static const symbol s_25_18[4] = { 0xBA9, 0xBC6, 0xBA9, 0xBCD };
static const symbol s_25_19[3] = { 0xBC7, 0xBA9, 0xBCD };
static const symbol s_25_20[3] = { 0xBA9, 0xBAE, 0xBCD };
static const symbol s_25_21[3] = { 0xBAA, 0xBAE, 0xBCD };
static const symbol s_25_22[3] = { 0xBBE, 0xBAE, 0xBCD };
static const symbol s_25_23[4] = { 0xB95, 0xBC1, 0xBAE, 0xBCD };
static const symbol s_25_24[4] = { 0xB9F, 0xBC1, 0xBAE, 0xBCD };
static const symbol s_25_25[4] = { 0xBA4, 0xBC1, 0xBAE, 0xBCD };
static const symbol s_25_26[4] = { 0xBB1, 0xBC1, 0xBAE, 0xBCD };
static const symbol s_25_27[3] = { 0xBC6, 0xBAE, 0xBCD };
static const symbol s_25_28[3] = { 0xBC7, 0xBAE, 0xBCD };
static const symbol s_25_29[3] = { 0xBCB, 0xBAE, 0xBCD };
static const symbol s_25_30[3] = { 0xBBE, 0xBAF, 0xBCD };
static const symbol s_25_31[3] = { 0xBA9, 0xBB0, 0xBCD };
static const symbol s_25_32[3] = { 0xBAA, 0xBB0, 0xBCD };
static const symbol s_25_33[4] = { 0xBC0, 0xBAF, 0xBB0, 0xBCD };
static const symbol s_25_34[3] = { 0xBB5, 0xBB0, 0xBCD };
static const symbol s_25_35[3] = { 0xBBE, 0xBB0, 0xBCD };
static const symbol s_25_36[4] = { 0xBA9, 0xBBE, 0xBB0, 0xBCD };
static const symbol s_25_37[4] = { 0xBAE, 0xBBE, 0xBB0, 0xBCD };
static const symbol s_25_38[8] = { 0xB95, 0xBCA, 0xBA3, 0xBCD, 0xB9F, 0xBBF, 0xBB0, 0xBCD };
static const symbol s_25_39[4] = { 0xBA9, 0xBBF, 0xBB0, 0xBCD };
static const symbol s_25_40[3] = { 0xBC0, 0xBB0, 0xBCD };
static const symbol s_25_41[3] = { 0xBA9, 0xBB3, 0xBCD };
static const symbol s_25_42[3] = { 0xBAA, 0xBB3, 0xBCD };
static const symbol s_25_43[3] = { 0xBB5, 0xBB3, 0xBCD };
static const symbol s_25_44[3] = { 0xBBE, 0xBB3, 0xBCD };
static const symbol s_25_45[4] = { 0xBA9, 0xBBE, 0xBB3, 0xBCD };
static const struct among a_25[46] = {
{ 1, s_25_0, 0, 1, 0},
{ 1, s_25_1, 0, 1, 0},
{ 1, s_25_2, 0, 1, 0},
{ 1, s_25_3, 0, 1, 0},
{ 1, s_25_4, 0, 1, 0},
{ 1, s_25_5, 0, 5, 0},
{ 2, s_25_6, 0, 6, 0},
{ 3, s_25_7, 0, 1, 0},
{ 2, s_25_8, 0, 3, 0},
{ 5, s_25_9, 0, 1, 0},
{ 2, s_25_10, 0, 1, 0},
{ 2, s_25_11, 0, 1, 0},
{ 3, s_25_12, 0, 1, 0},
{ 3, s_25_13, 0, 1, 0},
{ 3, s_25_14, 0, 2, 0},
{ 3, s_25_15, 0, 4, 0},
{ 4, s_25_16, -1, 1, 0},
{ 4, s_25_17, 0, 1, 0},
{ 4, s_25_18, 0, 1, 0},
{ 3, s_25_19, 0, 5, 0},
{ 3, s_25_20, 0, 1, 0},
{ 3, s_25_21, 0, 1, 0},
{ 3, s_25_22, 0, 5, 0},
{ 4, s_25_23, 0, 1, 0},
{ 4, s_25_24, 0, 5, 0},
{ 4, s_25_25, 0, 1, 0},
{ 4, s_25_26, 0, 1, 0},
{ 3, s_25_27, 0, 5, 0},
{ 3, s_25_28, 0, 5, 0},
{ 3, s_25_29, 0, 5, 0},
{ 3, s_25_30, 0, 5, 0},
{ 3, s_25_31, 0, 1, 0},
{ 3, s_25_32, 0, 1, 0},
{ 4, s_25_33, 0, 5, 0},
{ 3, s_25_34, 0, 1, 0},
{ 3, s_25_35, 0, 5, 0},
{ 4, s_25_36, -1, 1, 0},
{ 4, s_25_37, -2, 1, 0},
{ 8, s_25_38, 0, 1, 0},
{ 4, s_25_39, 0, 5, 0},
{ 3, s_25_40, 0, 5, 0},
{ 3, s_25_41, 0, 1, 0},
{ 3, s_25_42, 0, 1, 0},
{ 3, s_25_43, 0, 1, 0},
{ 3, s_25_44, 0, 5, 0},
{ 4, s_25_45, -1, 1, 0}
};

static const symbol s_26_0[3] = { 0xB95, 0xBBF, 0xBB1 };
static const symbol s_26_1[5] = { 0xB95, 0xBBF, 0xBA9, 0xBCD, 0xBB1 };
static const symbol s_26_2[6] = { 0xBBE, 0xBA8, 0xBBF, 0xBA9, 0xBCD, 0xBB1 };
static const symbol s_26_3[4] = { 0xB95, 0xBBF, 0xBB1, 0xBCD };
static const symbol s_26_4[6] = { 0xB95, 0xBBF, 0xBA9, 0xBCD, 0xBB1, 0xBCD };
static const symbol s_26_5[7] = { 0xBBE, 0xBA8, 0xBBF, 0xBA9, 0xBCD, 0xBB1, 0xBCD };
static const struct among a_26[6] = {
{ 3, s_26_0, 0, -1, 0},
{ 5, s_26_1, 0, -1, 0},
{ 6, s_26_2, 0, -1, 0},
{ 4, s_26_3, 0, -1, 0},
{ 6, s_26_4, 0, -1, 0},
{ 7, s_26_5, 0, -1, 0}
};

static int r_fix_va_start(struct SN_env * z) {
    int among_var;
    z->bra = z->c;
    if (z->c + 1 >= z->l || z->p[z->c + 1] >> 5 != 94 || !((3078 >> (z->p[z->c + 1] & 0x1f)) & 1)) return 0;
    among_var = find_among(z, a_0, 4, 0);
    if (!among_var) return 0;
    z->ket = z->c;
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
    }
    return 1;
}

static int r_fix_endings(struct SN_env * z) {
    {
        int v_1 = z->c;
        while (1) {
            int v_2 = z->c;
            {
                int ret = r_fix_ending(z);
                if (ret == 0) goto lab1;
                if (ret < 0) return ret;
            }
            continue;
        lab1:
            z->c = v_2;
            break;
        }
        z->c = v_1;
    }
    return 1;
}

static int r_fix_ending(struct SN_env * z) {
    int among_var;
    if (SIZE(z->p) < 4) return 0;
    z->lb = z->c; z->c = z->l;
    do {
        int v_1 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_5, 17, 0);
        if (!among_var) goto lab0;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int v_2 = z->l - z->c;
                    if (!find_among_b(z, a_2, 3, 0)) goto lab0;
                    z->c = z->l - v_2;
                }
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 2, s_4);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 2, s_5);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                {
                    int ret = slice_from_s(z, 2, s_6);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                if (!((SN_local *)z)->b_found_vetrumai_urupu) goto lab0;
                if (z->c <= z->lb || z->p[z->c - 1] != 0xBC8) goto lab1;
                z->c--;
                goto lab0;
            lab1:
                {
                    int ret = slice_from_s(z, 2, s_7);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                {
                    int ret = slice_from_s(z, 1, s_8);
                    if (ret < 0) return ret;
                }
                break;
            case 8:
                {
                    int v_3 = z->l - z->c;
                    if (!find_among_b(z, a_3, 8, 0)) goto lab2;
                    goto lab0;
                lab2:
                    z->c = z->l - v_3;
                }
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 9:
                if (z->c <= z->lb || (z->p[z->c - 1] != 3016 && z->p[z->c - 1] != 3021)) among_var = 2; else
                among_var = find_among_b(z, a_4, 3, 0);
                switch (among_var) {
                    case 1:
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 2:
                        {
                            int ret = slice_from_s(z, 2, s_9);
                            if (ret < 0) return ret;
                        }
                        break;
                }
                break;
        }
        break;
    lab0:
        z->c = z->l - v_1;
        z->ket = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] != 0xBCD) return 0;
        z->c--;
        do {
            int v_4 = z->l - z->c;
            if (!find_among_b(z, a_6, 6, 0)) goto lab3;
            {
                int v_5 = z->l - z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 0xBCD) { z->c = z->l - v_5; goto lab4; }
                z->c--;
                if (!find_among_b(z, a_7, 6, 0)) { z->c = z->l - v_5; goto lab4; }
            lab4:
                ;
            }
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        lab3:
            z->c = z->l - v_4;
            if (!find_among_b(z, a_8, 11, 0)) goto lab5;
            z->bra = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 0xBCD) goto lab5;
            z->c--;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        lab5:
            z->c = z->l - v_4;
            {
                int v_6 = z->l - z->c;
                if (!find_among_b(z, a_9, 9, 0)) return 0;
                z->c = z->l - v_6;
            }
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        } while (0);
    } while (0);
    z->c = z->lb;
    return 1;
}

extern int tamil_stem(struct SN_env * z) {
    int among_var;
    int b_found_a_match;
    ((SN_local *)z)->b_found_vetrumai_urupu = 0;
    {
        int v_1 = z->c;
        {
            int ret = r_fix_ending(z);
            if (ret < 0) return ret;
        }
        z->c = v_1;
    }
    if (SIZE(z->p) < 5) return 0;
    {
        int v_2 = z->c;
        z->bra = z->c;
        if (z->c == z->l || z->p[z->c] != 0xB8E) goto lab0;
        z->c++;
        if (!find_among(z, a_1, 10, 0)) goto lab0;
        if (z->c == z->l || z->p[z->c] != 0xBCD) goto lab0;
        z->c++;
        z->ket = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        {
            int v_3 = z->c;
            {
                int ret = r_fix_va_start(z);
                if (ret < 0) return ret;
            }
            z->c = v_3;
        }
    lab0:
        z->c = v_2;
    }
    {
        int v_4 = z->c;
        z->bra = z->c;
        if (z->c >= z->l || z->p[z->c + 0] >> 5 != 92 || !((672 >> (z->p[z->c + 0] & 0x1f)) & 1)) goto lab1;
        z->c++;
        if (!find_among(z, a_11, 10, 0)) goto lab1;
        if (z->c == z->l || z->p[z->c] != 0xBCD) goto lab1;
        z->c++;
        z->ket = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        {
            int v_5 = z->c;
            {
                int ret = r_fix_va_start(z);
                if (ret < 0) return ret;
            }
            z->c = v_5;
        }
    lab1:
        z->c = v_4;
    }
    if (SIZE(z->p) < 5) goto lab2;
    z->lb = z->c; z->c = z->l;
    {
        int v_6 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_14, 3, 0)) goto lab3;
        z->bra = z->c;
        {
            int ret = slice_from_s(z, 1, s_10);
            if (ret < 0) return ret;
        }
    lab3:
        z->c = z->l - v_6;
    }
    z->c = z->lb;
    {
        int ret = r_fix_endings(z);
        if (ret < 0) return ret;
    }
lab2:
    {
        int v_7 = z->c;
        if (SIZE(z->p) < 5) goto lab4;
        z->lb = z->c; z->c = z->l;
        z->ket = z->c;
        if (!(eq_s_b(z, 3, s_11))) goto lab4;
        z->bra = z->c;
        {
            int ret = slice_from_s(z, 1, s_12);
            if (ret < 0) return ret;
        }
        z->c = z->lb;
        {
            int v_8 = z->c;
            {
                int ret = r_fix_ending(z);
                if (ret < 0) return ret;
            }
            z->c = v_8;
        }
    lab4:
        z->c = v_7;
    }
    {
        int v_9 = z->c;
        if (SIZE(z->p) < 5) goto lab5;
        z->lb = z->c; z->c = z->l;
        z->ket = z->c;
        among_var = find_among_b(z, a_17, 26, 0);
        if (!among_var) goto lab5;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_13);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int v_10 = z->l - z->c;
                    if (!find_among_b(z, a_16, 8, 0)) goto lab6;
                    goto lab5;
                lab6:
                    z->c = z->l - v_10;
                }
                {
                    int ret = slice_from_s(z, 1, s_14);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
        }
        z->c = z->lb;
        {
            int ret = r_fix_endings(z);
            if (ret < 0) return ret;
        }
    lab5:
        z->c = v_9;
    }
    {
        int v_11 = z->c;
        ((SN_local *)z)->b_found_vetrumai_urupu = 0;
        if (SIZE(z->p) < 5) goto lab7;
        z->lb = z->c; z->c = z->l;
        do {
            int v_12 = z->l - z->c;
            {
                int v_13 = z->l - z->c;
                z->ket = z->c;
                among_var = find_among_b(z, a_20, 22, 0);
                if (!among_var) goto lab8;
                z->bra = z->c;
                switch (among_var) {
                    case 1:
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 2:
                        {
                            int ret = slice_from_s(z, 1, s_15);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 3:
                        if (z->c <= z->lb || z->p[z->c - 1] != 0xBAE) goto lab9;
                        z->c--;
                        goto lab8;
                    lab9:
                        {
                            int ret = slice_from_s(z, 1, s_16);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 4:
                        if (SIZE(z->p) < 7) goto lab8;
                        {
                            int ret = slice_from_s(z, 1, s_17);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 5:
                        {
                            int v_14 = z->l - z->c;
                            if (!find_among_b(z, a_18, 8, 0)) goto lab10;
                            goto lab8;
                        lab10:
                            z->c = z->l - v_14;
                        }
                        {
                            int ret = slice_from_s(z, 1, s_18);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 6:
                        {
                            int v_15 = z->l - z->c;
                            if (!find_among_b(z, a_19, 8, 0)) goto lab11;
                            goto lab8;
                        lab11:
                            z->c = z->l - v_15;
                        }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 7:
                        {
                            int ret = slice_from_s(z, 1, s_19);
                            if (ret < 0) return ret;
                        }
                        break;
                }
                z->c = z->l - v_13;
            }
            break;
        lab8:
            z->c = z->l - v_12;
            {
                int v_16 = z->l - z->c;
                z->ket = z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 0xBC8) goto lab7;
                z->c--;
                do {
                    int v_17 = z->l - z->c;
                    {
                        int v_18 = z->l - z->c;
                        if (!find_among_b(z, a_21, 6, 0)) goto lab13;
                        goto lab12;
                    lab13:
                        z->c = z->l - v_18;
                    }
                    break;
                lab12:
                    z->c = z->l - v_17;
                    {
                        int v_19 = z->l - z->c;
                        if (!find_among_b(z, a_22, 6, 0)) goto lab7;
                        if (z->c <= z->lb || z->p[z->c - 1] != 0xBCD) goto lab7;
                        z->c--;
                        z->c = z->l - v_19;
                    }
                } while (0);
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 1, s_20);
                    if (ret < 0) return ret;
                }
                z->c = z->l - v_16;
            }
        } while (0);
        ((SN_local *)z)->b_found_vetrumai_urupu = 1;
        {
            int v_20 = z->l - z->c;
            z->ket = z->c;
            if (!(eq_s_b(z, 3, s_21))) goto lab14;
            z->bra = z->c;
            {
                int ret = slice_from_s(z, 1, s_22);
                if (ret < 0) return ret;
            }
        lab14:
            z->c = z->l - v_20;
        }
        z->c = z->lb;
        {
            int ret = r_fix_endings(z);
            if (ret < 0) return ret;
        }
    lab7:
        z->c = v_11;
    }
    {
        int v_21 = z->c;
        z->lb = z->c; z->c = z->l;
        z->ket = z->c;
        if (z->c - 2 <= z->lb || z->p[z->c - 1] != 3021) goto lab15;
        among_var = find_among_b(z, a_13, 4, 0);
        if (!among_var) goto lab15;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                do {
                    int v_22 = z->l - z->c;
                    if (!find_among_b(z, a_12, 6, 0)) goto lab16;
                    {
                        int ret = slice_from_s(z, 3, s_23);
                        if (ret < 0) return ret;
                    }
                    break;
                lab16:
                    z->c = z->l - v_22;
                    {
                        int ret = slice_from_s(z, 1, s_24);
                        if (ret < 0) return ret;
                    }
                } while (0);
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 2, s_25);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 2, s_26);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
        }
        z->c = z->lb;
    lab15:
        z->c = v_21;
    }
    {
        int v_23 = z->c;
        if (SIZE(z->p) < 5) goto lab17;
        z->lb = z->c; z->c = z->l;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] != 3007) goto lab17;
        if (!find_among_b(z, a_15, 2, 0)) goto lab17;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        z->c = z->lb;
    lab17:
        z->c = v_23;
    }
    {
        int v_24 = z->c;
        while (1) {
            int v_25 = z->c;
            b_found_a_match = 0;
            if (SIZE(z->p) < 5) goto lab19;
            z->lb = z->c; z->c = z->l;
            {
                int v_26 = z->l - z->c;
                {
                    int v_27 = z->l - z->c;
                    z->ket = z->c;
                    among_var = find_among_b(z, a_25, 46, 0);
                    if (!among_var) goto lab20;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            {
                                int v_28 = z->l - z->c;
                                if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 92 || !((1951712 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab21;
                                z->c--;
                                goto lab20;
                            lab21:
                                z->c = z->l - v_28;
                            }
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 3:
                            {
                                int v_29 = z->l - z->c;
                                if (!find_among_b(z, a_24, 8, 0)) goto lab22;
                                goto lab20;
                            lab22:
                                z->c = z->l - v_29;
                            }
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 4:
                            if (z->c <= z->lb || z->p[z->c - 1] != 0xB9A) goto lab23;
                            z->c--;
                            goto lab20;
                        lab23:
                            {
                                int ret = slice_from_s(z, 1, s_27);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 5:
                            {
                                int ret = slice_from_s(z, 1, s_28);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 6:
                            {
                                int v_30 = z->l - z->c;
                                if (z->c <= z->lb || z->p[z->c - 1] != 0xBCD) goto lab20;
                                z->c--;
                                z->c = z->l - v_30;
                            }
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                    }
                    b_found_a_match = 1;
                    z->c = z->l - v_27;
                }
            lab20:
                z->c = z->l - v_26;
            }
            {
                int v_31 = z->l - z->c;
                z->ket = z->c;
                if (z->c - 2 <= z->lb || (z->p[z->c - 1] != 2993 && z->p[z->c - 1] != 3021)) goto lab24;
                if (!find_among_b(z, a_26, 6, 0)) goto lab24;
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                b_found_a_match = 1;
            lab24:
                z->c = z->l - v_31;
            }
            z->c = z->lb;
            {
                int ret = r_fix_endings(z);
                if (ret < 0) return ret;
            }
            if (!b_found_a_match) goto lab19;
            continue;
        lab19:
            z->c = v_25;
            break;
        }
        z->c = v_24;
    }
    return 1;
}

extern struct SN_env * tamil_create_env(void) {
    return SN_new_env(sizeof(SN_local));
}
