/*
 * Generated from algorithms/italian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "italian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int italian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 0xE0 };
static const symbol s_1[] = { 0xE8 };
static const symbol s_2[] = { 0xEC };
static const symbol s_3[] = { 0xF2 };
static const symbol s_4[] = { 0xF9 };
static const symbol s_5[] = { 'q', 'U' };
static const symbol s_6[] = { 'U' };
static const symbol s_7[] = { 'I' };
static const symbol s_8[] = { 'd', 'i', 'v', 'a', 'n' };
static const symbol s_9[] = { 'e' };
static const symbol s_10[] = { 'i', 'c' };
static const symbol s_11[] = { 'l', 'o', 'g' };
static const symbol s_12[] = { 'u' };
static const symbol s_13[] = { 'e', 'n', 't', 'e' };
static const symbol s_14[] = { 'a', 't' };
static const symbol s_15[] = { 'a', 't' };
static const symbol s_16[] = { 'i', 'c' };
static const symbol s_17[] = { 'i' };
static const symbol s_18[] = { 'u' };

static const symbol s_0_0[4] = { 'a', 'l', 'l', '\'' };
static const symbol s_0_1[2] = { 'd', '\'' };
static const symbol s_0_2[5] = { 'd', 'a', 'l', 'l', '\'' };
static const symbol s_0_3[5] = { 'd', 'e', 'l', 'l', '\'' };
static const symbol s_0_4[3] = { 'g', 'l', '\'' };
static const symbol s_0_5[2] = { 'l', '\'' };
static const symbol s_0_6[2] = { 'm', '\'' };
static const symbol s_0_7[5] = { 'n', 'e', 'l', 'l', '\'' };
static const symbol s_0_8[6] = { 'q', 'u', 'e', 'l', 'l', '\'' };
static const symbol s_0_9[6] = { 'q', 'u', 'e', 's', 't', '\'' };
static const symbol s_0_10[2] = { 's', '\'' };
static const symbol s_0_11[5] = { 's', 'u', 'l', 'l', '\'' };
static const symbol s_0_12[2] = { 't', '\'' };
static const symbol s_0_13[5] = { 't', 'u', 't', 't', '\'' };
static const symbol s_0_14[3] = { 'u', 'n', '\'' };
static const symbol s_0_15[2] = { 'v', '\'' };
static const struct among a_0[16] = {
{ 4, s_0_0, 0, -1, 0},
{ 2, s_0_1, 0, -1, 0},
{ 5, s_0_2, 0, -1, 0},
{ 5, s_0_3, 0, -1, 0},
{ 3, s_0_4, 0, -1, 0},
{ 2, s_0_5, 0, -1, 0},
{ 2, s_0_6, 0, -1, 0},
{ 5, s_0_7, 0, -1, 0},
{ 6, s_0_8, 0, -1, 0},
{ 6, s_0_9, 0, -1, 0},
{ 2, s_0_10, 0, -1, 0},
{ 5, s_0_11, 0, -1, 0},
{ 2, s_0_12, 0, -1, 0},
{ 5, s_0_13, 0, -1, 0},
{ 3, s_0_14, 0, -1, 0},
{ 2, s_0_15, 0, -1, 0}
};

static const symbol s_1_1[2] = { 'q', 'u' };
static const symbol s_1_2[1] = { 0xE1 };
static const symbol s_1_3[1] = { 0xE9 };
static const symbol s_1_4[1] = { 0xED };
static const symbol s_1_5[1] = { 0xF3 };
static const symbol s_1_6[1] = { 0xFA };
static const struct among a_1[7] = {
{ 0, 0, 0, 7, 0},
{ 2, s_1_1, -1, 6, 0},
{ 1, s_1_2, -2, 1, 0},
{ 1, s_1_3, -3, 2, 0},
{ 1, s_1_4, -4, 3, 0},
{ 1, s_1_5, -5, 4, 0},
{ 1, s_1_6, -6, 5, 0}
};

static const symbol s_2_1[1] = { 'I' };
static const symbol s_2_2[1] = { 'U' };
static const struct among a_2[3] = {
{ 0, 0, 0, 3, 0},
{ 1, s_2_1, -1, 1, 0},
{ 1, s_2_2, -2, 2, 0}
};

static const symbol s_3_0[2] = { 'l', 'a' };
static const symbol s_3_1[4] = { 'c', 'e', 'l', 'a' };
static const symbol s_3_2[6] = { 'g', 'l', 'i', 'e', 'l', 'a' };
static const symbol s_3_3[4] = { 'm', 'e', 'l', 'a' };
static const symbol s_3_4[4] = { 't', 'e', 'l', 'a' };
static const symbol s_3_5[4] = { 'v', 'e', 'l', 'a' };
static const symbol s_3_6[2] = { 'l', 'e' };
static const symbol s_3_7[4] = { 'c', 'e', 'l', 'e' };
static const symbol s_3_8[6] = { 'g', 'l', 'i', 'e', 'l', 'e' };
static const symbol s_3_9[4] = { 'm', 'e', 'l', 'e' };
static const symbol s_3_10[4] = { 't', 'e', 'l', 'e' };
static const symbol s_3_11[4] = { 'v', 'e', 'l', 'e' };
static const symbol s_3_12[2] = { 'n', 'e' };
static const symbol s_3_13[4] = { 'c', 'e', 'n', 'e' };
static const symbol s_3_14[6] = { 'g', 'l', 'i', 'e', 'n', 'e' };
static const symbol s_3_15[4] = { 'm', 'e', 'n', 'e' };
static const symbol s_3_16[4] = { 's', 'e', 'n', 'e' };
static const symbol s_3_17[4] = { 't', 'e', 'n', 'e' };
static const symbol s_3_18[4] = { 'v', 'e', 'n', 'e' };
static const symbol s_3_19[2] = { 'c', 'i' };
static const symbol s_3_20[2] = { 'l', 'i' };
static const symbol s_3_21[4] = { 'c', 'e', 'l', 'i' };
static const symbol s_3_22[6] = { 'g', 'l', 'i', 'e', 'l', 'i' };
static const symbol s_3_23[4] = { 'm', 'e', 'l', 'i' };
static const symbol s_3_24[4] = { 't', 'e', 'l', 'i' };
static const symbol s_3_25[4] = { 'v', 'e', 'l', 'i' };
static const symbol s_3_26[3] = { 'g', 'l', 'i' };
static const symbol s_3_27[2] = { 'm', 'i' };
static const symbol s_3_28[2] = { 's', 'i' };
static const symbol s_3_29[2] = { 't', 'i' };
static const symbol s_3_30[2] = { 'v', 'i' };
static const symbol s_3_31[2] = { 'l', 'o' };
static const symbol s_3_32[4] = { 'c', 'e', 'l', 'o' };
static const symbol s_3_33[6] = { 'g', 'l', 'i', 'e', 'l', 'o' };
static const symbol s_3_34[4] = { 'm', 'e', 'l', 'o' };
static const symbol s_3_35[4] = { 't', 'e', 'l', 'o' };
static const symbol s_3_36[4] = { 'v', 'e', 'l', 'o' };
static const struct among a_3[37] = {
{ 2, s_3_0, 0, -1, 0},
{ 4, s_3_1, -1, -1, 0},
{ 6, s_3_2, -2, -1, 0},
{ 4, s_3_3, -3, -1, 0},
{ 4, s_3_4, -4, -1, 0},
{ 4, s_3_5, -5, -1, 0},
{ 2, s_3_6, 0, -1, 0},
{ 4, s_3_7, -1, -1, 0},
{ 6, s_3_8, -2, -1, 0},
{ 4, s_3_9, -3, -1, 0},
{ 4, s_3_10, -4, -1, 0},
{ 4, s_3_11, -5, -1, 0},
{ 2, s_3_12, 0, -1, 0},
{ 4, s_3_13, -1, -1, 0},
{ 6, s_3_14, -2, -1, 0},
{ 4, s_3_15, -3, -1, 0},
{ 4, s_3_16, -4, -1, 0},
{ 4, s_3_17, -5, -1, 0},
{ 4, s_3_18, -6, -1, 0},
{ 2, s_3_19, 0, -1, 0},
{ 2, s_3_20, 0, -1, 0},
{ 4, s_3_21, -1, -1, 0},
{ 6, s_3_22, -2, -1, 0},
{ 4, s_3_23, -3, -1, 0},
{ 4, s_3_24, -4, -1, 0},
{ 4, s_3_25, -5, -1, 0},
{ 3, s_3_26, -6, -1, 0},
{ 2, s_3_27, 0, -1, 0},
{ 2, s_3_28, 0, -1, 0},
{ 2, s_3_29, 0, -1, 0},
{ 2, s_3_30, 0, -1, 0},
{ 2, s_3_31, 0, -1, 0},
{ 4, s_3_32, -1, -1, 0},
{ 6, s_3_33, -2, -1, 0},
{ 4, s_3_34, -3, -1, 0},
{ 4, s_3_35, -4, -1, 0},
{ 4, s_3_36, -5, -1, 0}
};

static const symbol s_4_0[4] = { 'a', 'n', 'd', 'o' };
static const symbol s_4_1[4] = { 'e', 'n', 'd', 'o' };
static const symbol s_4_2[2] = { 'a', 'r' };
static const symbol s_4_3[2] = { 'e', 'r' };
static const symbol s_4_4[2] = { 'i', 'r' };
static const struct among a_4[5] = {
{ 4, s_4_0, 0, 1, 0},
{ 4, s_4_1, 0, 1, 0},
{ 2, s_4_2, 0, 2, 0},
{ 2, s_4_3, 0, 2, 0},
{ 2, s_4_4, 0, 2, 0}
};

static const symbol s_5_0[2] = { 'i', 'c' };
static const symbol s_5_1[4] = { 'a', 'b', 'i', 'l' };
static const symbol s_5_2[2] = { 'o', 's' };
static const symbol s_5_3[2] = { 'i', 'v' };
static const struct among a_5[4] = {
{ 2, s_5_0, 0, -1, 0},
{ 4, s_5_1, 0, -1, 0},
{ 2, s_5_2, 0, -1, 0},
{ 2, s_5_3, 0, 1, 0}
};

static const symbol s_6_0[2] = { 'i', 'c' };
static const symbol s_6_1[4] = { 'a', 'b', 'i', 'l' };
static const symbol s_6_2[2] = { 'i', 'v' };
static const struct among a_6[3] = {
{ 2, s_6_0, 0, 1, 0},
{ 4, s_6_1, 0, 1, 0},
{ 2, s_6_2, 0, 1, 0}
};

static const symbol s_7_0[3] = { 'i', 'c', 'a' };
static const symbol s_7_1[5] = { 'l', 'o', 'g', 'i', 'a' };
static const symbol s_7_2[3] = { 'o', 's', 'a' };
static const symbol s_7_3[4] = { 'i', 's', 't', 'a' };
static const symbol s_7_4[3] = { 'i', 'v', 'a' };
static const symbol s_7_5[4] = { 'a', 'n', 'z', 'a' };
static const symbol s_7_6[4] = { 'e', 'n', 'z', 'a' };
static const symbol s_7_7[3] = { 'i', 'c', 'e' };
static const symbol s_7_8[6] = { 'a', 't', 'r', 'i', 'c', 'e' };
static const symbol s_7_9[4] = { 'i', 'c', 'h', 'e' };
static const symbol s_7_10[5] = { 'l', 'o', 'g', 'i', 'e' };
static const symbol s_7_11[5] = { 'a', 'b', 'i', 'l', 'e' };
static const symbol s_7_12[5] = { 'i', 'b', 'i', 'l', 'e' };
static const symbol s_7_13[6] = { 'u', 's', 'i', 'o', 'n', 'e' };
static const symbol s_7_14[6] = { 'a', 'z', 'i', 'o', 'n', 'e' };
static const symbol s_7_15[6] = { 'u', 'z', 'i', 'o', 'n', 'e' };
static const symbol s_7_16[5] = { 'a', 't', 'o', 'r', 'e' };
static const symbol s_7_17[3] = { 'o', 's', 'e' };
static const symbol s_7_18[4] = { 'a', 'n', 't', 'e' };
static const symbol s_7_19[5] = { 'm', 'e', 'n', 't', 'e' };
static const symbol s_7_20[6] = { 'a', 'm', 'e', 'n', 't', 'e' };
static const symbol s_7_21[4] = { 'i', 's', 't', 'e' };
static const symbol s_7_22[3] = { 'i', 'v', 'e' };
static const symbol s_7_23[4] = { 'a', 'n', 'z', 'e' };
static const symbol s_7_24[4] = { 'e', 'n', 'z', 'e' };
static const symbol s_7_25[3] = { 'i', 'c', 'i' };
static const symbol s_7_26[6] = { 'a', 't', 'r', 'i', 'c', 'i' };
static const symbol s_7_27[4] = { 'i', 'c', 'h', 'i' };
static const symbol s_7_28[5] = { 'a', 'b', 'i', 'l', 'i' };
static const symbol s_7_29[5] = { 'i', 'b', 'i', 'l', 'i' };
static const symbol s_7_30[4] = { 'i', 's', 'm', 'i' };
static const symbol s_7_31[6] = { 'u', 's', 'i', 'o', 'n', 'i' };
static const symbol s_7_32[6] = { 'a', 'z', 'i', 'o', 'n', 'i' };
static const symbol s_7_33[6] = { 'u', 'z', 'i', 'o', 'n', 'i' };
static const symbol s_7_34[5] = { 'a', 't', 'o', 'r', 'i' };
static const symbol s_7_35[3] = { 'o', 's', 'i' };
static const symbol s_7_36[4] = { 'a', 'n', 't', 'i' };
static const symbol s_7_37[6] = { 'a', 'm', 'e', 'n', 't', 'i' };
static const symbol s_7_38[6] = { 'i', 'm', 'e', 'n', 't', 'i' };
static const symbol s_7_39[4] = { 'i', 's', 't', 'i' };
static const symbol s_7_40[3] = { 'i', 'v', 'i' };
static const symbol s_7_41[3] = { 'i', 'c', 'o' };
static const symbol s_7_42[4] = { 'i', 's', 'm', 'o' };
static const symbol s_7_43[3] = { 'o', 's', 'o' };
static const symbol s_7_44[6] = { 'a', 'm', 'e', 'n', 't', 'o' };
static const symbol s_7_45[6] = { 'i', 'm', 'e', 'n', 't', 'o' };
static const symbol s_7_46[3] = { 'i', 'v', 'o' };
static const symbol s_7_47[3] = { 'i', 't', 0xE0 };
static const symbol s_7_48[4] = { 'i', 's', 't', 0xE0 };
static const symbol s_7_49[4] = { 'i', 's', 't', 0xE8 };
static const symbol s_7_50[4] = { 'i', 's', 't', 0xEC };
static const struct among a_7[51] = {
{ 3, s_7_0, 0, 1, 0},
{ 5, s_7_1, 0, 3, 0},
{ 3, s_7_2, 0, 1, 0},
{ 4, s_7_3, 0, 1, 0},
{ 3, s_7_4, 0, 9, 0},
{ 4, s_7_5, 0, 1, 0},
{ 4, s_7_6, 0, 5, 0},
{ 3, s_7_7, 0, 1, 0},
{ 6, s_7_8, -1, 1, 0},
{ 4, s_7_9, 0, 1, 0},
{ 5, s_7_10, 0, 3, 0},
{ 5, s_7_11, 0, 1, 0},
{ 5, s_7_12, 0, 1, 0},
{ 6, s_7_13, 0, 4, 0},
{ 6, s_7_14, 0, 2, 0},
{ 6, s_7_15, 0, 4, 0},
{ 5, s_7_16, 0, 2, 0},
{ 3, s_7_17, 0, 1, 0},
{ 4, s_7_18, 0, 1, 0},
{ 5, s_7_19, 0, 1, 0},
{ 6, s_7_20, -1, 7, 0},
{ 4, s_7_21, 0, 1, 0},
{ 3, s_7_22, 0, 9, 0},
{ 4, s_7_23, 0, 1, 0},
{ 4, s_7_24, 0, 5, 0},
{ 3, s_7_25, 0, 1, 0},
{ 6, s_7_26, -1, 1, 0},
{ 4, s_7_27, 0, 1, 0},
{ 5, s_7_28, 0, 1, 0},
{ 5, s_7_29, 0, 1, 0},
{ 4, s_7_30, 0, 1, 0},
{ 6, s_7_31, 0, 4, 0},
{ 6, s_7_32, 0, 2, 0},
{ 6, s_7_33, 0, 4, 0},
{ 5, s_7_34, 0, 2, 0},
{ 3, s_7_35, 0, 1, 0},
{ 4, s_7_36, 0, 1, 0},
{ 6, s_7_37, 0, 6, 0},
{ 6, s_7_38, 0, 6, 0},
{ 4, s_7_39, 0, 1, 0},
{ 3, s_7_40, 0, 9, 0},
{ 3, s_7_41, 0, 1, 0},
{ 4, s_7_42, 0, 1, 0},
{ 3, s_7_43, 0, 1, 0},
{ 6, s_7_44, 0, 6, 0},
{ 6, s_7_45, 0, 6, 0},
{ 3, s_7_46, 0, 9, 0},
{ 3, s_7_47, 0, 8, 0},
{ 4, s_7_48, 0, 1, 0},
{ 4, s_7_49, 0, 1, 0},
{ 4, s_7_50, 0, 1, 0}
};

static const symbol s_8_0[4] = { 'i', 's', 'c', 'a' };
static const symbol s_8_1[4] = { 'e', 'n', 'd', 'a' };
static const symbol s_8_2[3] = { 'a', 't', 'a' };
static const symbol s_8_3[3] = { 'i', 't', 'a' };
static const symbol s_8_4[3] = { 'u', 't', 'a' };
static const symbol s_8_5[3] = { 'a', 'v', 'a' };
static const symbol s_8_6[3] = { 'e', 'v', 'a' };
static const symbol s_8_7[3] = { 'i', 'v', 'a' };
static const symbol s_8_8[6] = { 'e', 'r', 'e', 'b', 'b', 'e' };
static const symbol s_8_9[6] = { 'i', 'r', 'e', 'b', 'b', 'e' };
static const symbol s_8_10[4] = { 'i', 's', 'c', 'e' };
static const symbol s_8_11[4] = { 'e', 'n', 'd', 'e' };
static const symbol s_8_12[3] = { 'a', 'r', 'e' };
static const symbol s_8_13[3] = { 'e', 'r', 'e' };
static const symbol s_8_14[3] = { 'i', 'r', 'e' };
static const symbol s_8_15[4] = { 'a', 's', 's', 'e' };
static const symbol s_8_16[3] = { 'a', 't', 'e' };
static const symbol s_8_17[5] = { 'a', 'v', 'a', 't', 'e' };
static const symbol s_8_18[5] = { 'e', 'v', 'a', 't', 'e' };
static const symbol s_8_19[5] = { 'i', 'v', 'a', 't', 'e' };
static const symbol s_8_20[3] = { 'e', 't', 'e' };
static const symbol s_8_21[5] = { 'e', 'r', 'e', 't', 'e' };
static const symbol s_8_22[5] = { 'i', 'r', 'e', 't', 'e' };
static const symbol s_8_23[3] = { 'i', 't', 'e' };
static const symbol s_8_24[6] = { 'e', 'r', 'e', 's', 't', 'e' };
static const symbol s_8_25[6] = { 'i', 'r', 'e', 's', 't', 'e' };
static const symbol s_8_26[3] = { 'u', 't', 'e' };
static const symbol s_8_27[4] = { 'e', 'r', 'a', 'i' };
static const symbol s_8_28[4] = { 'i', 'r', 'a', 'i' };
static const symbol s_8_29[4] = { 'i', 's', 'c', 'i' };
static const symbol s_8_30[4] = { 'e', 'n', 'd', 'i' };
static const symbol s_8_31[4] = { 'e', 'r', 'e', 'i' };
static const symbol s_8_32[4] = { 'i', 'r', 'e', 'i' };
static const symbol s_8_33[4] = { 'a', 's', 's', 'i' };
static const symbol s_8_34[3] = { 'a', 't', 'i' };
static const symbol s_8_35[3] = { 'i', 't', 'i' };
static const symbol s_8_36[6] = { 'e', 'r', 'e', 's', 't', 'i' };
static const symbol s_8_37[6] = { 'i', 'r', 'e', 's', 't', 'i' };
static const symbol s_8_38[3] = { 'u', 't', 'i' };
static const symbol s_8_39[3] = { 'a', 'v', 'i' };
static const symbol s_8_40[3] = { 'e', 'v', 'i' };
static const symbol s_8_41[3] = { 'i', 'v', 'i' };
static const symbol s_8_42[4] = { 'i', 's', 'c', 'o' };
static const symbol s_8_43[4] = { 'a', 'n', 'd', 'o' };
static const symbol s_8_44[4] = { 'e', 'n', 'd', 'o' };
static const symbol s_8_45[4] = { 'Y', 'a', 'm', 'o' };
static const symbol s_8_46[4] = { 'i', 'a', 'm', 'o' };
static const symbol s_8_47[5] = { 'a', 'v', 'a', 'm', 'o' };
static const symbol s_8_48[5] = { 'e', 'v', 'a', 'm', 'o' };
static const symbol s_8_49[5] = { 'i', 'v', 'a', 'm', 'o' };
static const symbol s_8_50[5] = { 'e', 'r', 'e', 'm', 'o' };
static const symbol s_8_51[5] = { 'i', 'r', 'e', 'm', 'o' };
static const symbol s_8_52[6] = { 'a', 's', 's', 'i', 'm', 'o' };
static const symbol s_8_53[4] = { 'a', 'm', 'm', 'o' };
static const symbol s_8_54[4] = { 'e', 'm', 'm', 'o' };
static const symbol s_8_55[6] = { 'e', 'r', 'e', 'm', 'm', 'o' };
static const symbol s_8_56[6] = { 'i', 'r', 'e', 'm', 'm', 'o' };
static const symbol s_8_57[4] = { 'i', 'm', 'm', 'o' };
static const symbol s_8_58[3] = { 'a', 'n', 'o' };
static const symbol s_8_59[6] = { 'i', 's', 'c', 'a', 'n', 'o' };
static const symbol s_8_60[5] = { 'a', 'v', 'a', 'n', 'o' };
static const symbol s_8_61[5] = { 'e', 'v', 'a', 'n', 'o' };
static const symbol s_8_62[5] = { 'i', 'v', 'a', 'n', 'o' };
static const symbol s_8_63[6] = { 'e', 'r', 'a', 'n', 'n', 'o' };
static const symbol s_8_64[6] = { 'i', 'r', 'a', 'n', 'n', 'o' };
static const symbol s_8_65[3] = { 'o', 'n', 'o' };
static const symbol s_8_66[6] = { 'i', 's', 'c', 'o', 'n', 'o' };
static const symbol s_8_67[5] = { 'a', 'r', 'o', 'n', 'o' };
static const symbol s_8_68[5] = { 'e', 'r', 'o', 'n', 'o' };
static const symbol s_8_69[5] = { 'i', 'r', 'o', 'n', 'o' };
static const symbol s_8_70[8] = { 'e', 'r', 'e', 'b', 'b', 'e', 'r', 'o' };
static const symbol s_8_71[8] = { 'i', 'r', 'e', 'b', 'b', 'e', 'r', 'o' };
static const symbol s_8_72[6] = { 'a', 's', 's', 'e', 'r', 'o' };
static const symbol s_8_73[6] = { 'e', 's', 's', 'e', 'r', 'o' };
static const symbol s_8_74[6] = { 'i', 's', 's', 'e', 'r', 'o' };
static const symbol s_8_75[3] = { 'a', 't', 'o' };
static const symbol s_8_76[3] = { 'i', 't', 'o' };
static const symbol s_8_77[3] = { 'u', 't', 'o' };
static const symbol s_8_78[3] = { 'a', 'v', 'o' };
static const symbol s_8_79[3] = { 'e', 'v', 'o' };
static const symbol s_8_80[3] = { 'i', 'v', 'o' };
static const symbol s_8_81[2] = { 'a', 'r' };
static const symbol s_8_82[2] = { 'i', 'r' };
static const symbol s_8_83[3] = { 'e', 'r', 0xE0 };
static const symbol s_8_84[3] = { 'i', 'r', 0xE0 };
static const symbol s_8_85[3] = { 'e', 'r', 0xF2 };
static const symbol s_8_86[3] = { 'i', 'r', 0xF2 };
static const struct among a_8[87] = {
{ 4, s_8_0, 0, 1, 0},
{ 4, s_8_1, 0, 1, 0},
{ 3, s_8_2, 0, 1, 0},
{ 3, s_8_3, 0, 1, 0},
{ 3, s_8_4, 0, 1, 0},
{ 3, s_8_5, 0, 1, 0},
{ 3, s_8_6, 0, 1, 0},
{ 3, s_8_7, 0, 1, 0},
{ 6, s_8_8, 0, 1, 0},
{ 6, s_8_9, 0, 1, 0},
{ 4, s_8_10, 0, 1, 0},
{ 4, s_8_11, 0, 1, 0},
{ 3, s_8_12, 0, 1, 0},
{ 3, s_8_13, 0, 1, 0},
{ 3, s_8_14, 0, 1, 0},
{ 4, s_8_15, 0, 1, 0},
{ 3, s_8_16, 0, 1, 0},
{ 5, s_8_17, -1, 1, 0},
{ 5, s_8_18, -2, 1, 0},
{ 5, s_8_19, -3, 1, 0},
{ 3, s_8_20, 0, 1, 0},
{ 5, s_8_21, -1, 1, 0},
{ 5, s_8_22, -2, 1, 0},
{ 3, s_8_23, 0, 1, 0},
{ 6, s_8_24, 0, 1, 0},
{ 6, s_8_25, 0, 1, 0},
{ 3, s_8_26, 0, 1, 0},
{ 4, s_8_27, 0, 1, 0},
{ 4, s_8_28, 0, 1, 0},
{ 4, s_8_29, 0, 1, 0},
{ 4, s_8_30, 0, 1, 0},
{ 4, s_8_31, 0, 1, 0},
{ 4, s_8_32, 0, 1, 0},
{ 4, s_8_33, 0, 1, 0},
{ 3, s_8_34, 0, 1, 0},
{ 3, s_8_35, 0, 1, 0},
{ 6, s_8_36, 0, 1, 0},
{ 6, s_8_37, 0, 1, 0},
{ 3, s_8_38, 0, 1, 0},
{ 3, s_8_39, 0, 1, 0},
{ 3, s_8_40, 0, 1, 0},
{ 3, s_8_41, 0, 1, 0},
{ 4, s_8_42, 0, 1, 0},
{ 4, s_8_43, 0, 1, 0},
{ 4, s_8_44, 0, 1, 0},
{ 4, s_8_45, 0, 1, 0},
{ 4, s_8_46, 0, 1, 0},
{ 5, s_8_47, 0, 1, 0},
{ 5, s_8_48, 0, 1, 0},
{ 5, s_8_49, 0, 1, 0},
{ 5, s_8_50, 0, 1, 0},
{ 5, s_8_51, 0, 1, 0},
{ 6, s_8_52, 0, 1, 0},
{ 4, s_8_53, 0, 1, 0},
{ 4, s_8_54, 0, 1, 0},
{ 6, s_8_55, -1, 1, 0},
{ 6, s_8_56, -2, 1, 0},
{ 4, s_8_57, 0, 1, 0},
{ 3, s_8_58, 0, 1, 0},
{ 6, s_8_59, -1, 1, 0},
{ 5, s_8_60, -2, 1, 0},
{ 5, s_8_61, -3, 1, 0},
{ 5, s_8_62, -4, 1, 0},
{ 6, s_8_63, 0, 1, 0},
{ 6, s_8_64, 0, 1, 0},
{ 3, s_8_65, 0, 1, 0},
{ 6, s_8_66, -1, 1, 0},
{ 5, s_8_67, -2, 1, 0},
{ 5, s_8_68, -3, 1, 0},
{ 5, s_8_69, -4, 1, 0},
{ 8, s_8_70, 0, 1, 0},
{ 8, s_8_71, 0, 1, 0},
{ 6, s_8_72, 0, 1, 0},
{ 6, s_8_73, 0, 1, 0},
{ 6, s_8_74, 0, 1, 0},
{ 3, s_8_75, 0, 1, 0},
{ 3, s_8_76, 0, 1, 0},
{ 3, s_8_77, 0, 1, 0},
{ 3, s_8_78, 0, 1, 0},
{ 3, s_8_79, 0, 1, 0},
{ 3, s_8_80, 0, 1, 0},
{ 2, s_8_81, 0, 1, 0},
{ 2, s_8_82, 0, 1, 0},
{ 3, s_8_83, 0, 1, 0},
{ 3, s_8_84, 0, 1, 0},
{ 3, s_8_85, 0, 1, 0},
{ 3, s_8_86, 0, 1, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 8, 2, 1 };

static const unsigned char g_AEIO[] = { 17, 65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 128, 8, 2 };

static const unsigned char g_CG[] = { 17 };

extern int italian_stem(struct SN_env * z) {
    int among_var;
    int i_p2;
    int i_p1;
    int i_pV;
    {
        int v_1 = z->c;
        z->bra = z->c;
        if (!find_among(z, a_0, 16, 0)) goto lab0;
        z->ket = z->c;
        if (z->c >= z->l) goto lab0;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab0:
        z->c = v_1;
    }
    {
        int v_2 = z->c;
        {
            int v_3 = z->c;
            while (1) {
                int v_4 = z->c;
                z->bra = z->c;
                among_var = find_among(z, a_1, 7, 0);
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
                    case 5:
                        {
                            int ret = slice_from_s(z, 1, s_4);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 6:
                        {
                            int ret = slice_from_s(z, 2, s_5);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 7:
                        if (z->c >= z->l) goto lab2;
                        z->c++;
                        break;
                }
                continue;
            lab2:
                z->c = v_4;
                break;
            }
            z->c = v_3;
        }
        while (1) {
            int v_5 = z->c;
            while (1) {
                int v_6 = z->c;
                if (in_grouping(z, g_v, 97, 249, 0)) goto lab4;
                z->bra = z->c;
                do {
                    int v_7 = z->c;
                    if (z->c == z->l || z->p[z->c] != 'u') goto lab5;
                    z->c++;
                    z->ket = z->c;
                    if (in_grouping(z, g_v, 97, 249, 0)) goto lab5;
                    {
                        int ret = slice_from_s(z, 1, s_6);
                        if (ret < 0) return ret;
                    }
                    break;
                lab5:
                    z->c = v_7;
                    if (z->c == z->l || z->p[z->c] != 'i') goto lab4;
                    z->c++;
                    z->ket = z->c;
                    if (in_grouping(z, g_v, 97, 249, 0)) goto lab4;
                    {
                        int ret = slice_from_s(z, 1, s_7);
                        if (ret < 0) return ret;
                    }
                } while (0);
                z->c = v_6;
                break;
            lab4:
                z->c = v_6;
                if (z->c >= z->l) goto lab3;
                z->c++;
            }
            continue;
        lab3:
            z->c = v_5;
            break;
        }
        z->c = v_2;
    }
    i_pV = z->l;
    i_p1 = z->l;
    i_p2 = z->l;
    {
        int v_8 = z->c;
        do {
            int v_9 = z->c;
            if (in_grouping(z, g_v, 97, 249, 0)) goto lab8;
            do {
                int v_10 = z->c;
                if (out_grouping(z, g_v, 97, 249, 0)) goto lab9;
                {
                    int ret = out_grouping(z, g_v, 97, 249, 1);
                    if (ret < 0) goto lab9;
                    z->c += ret;
                }
                break;
            lab9:
                z->c = v_10;
                if (in_grouping(z, g_v, 97, 249, 0)) goto lab8;
                {
                    int ret = in_grouping(z, g_v, 97, 249, 1);
                    if (ret < 0) goto lab8;
                    z->c += ret;
                }
            } while (0);
            break;
        lab8:
            z->c = v_9;
            if (!(eq_s(z, 5, s_8))) goto lab10;
            break;
        lab10:
            if (out_grouping(z, g_v, 97, 249, 0)) goto lab7;
            do {
                int v_11 = z->c;
                if (out_grouping(z, g_v, 97, 249, 0)) goto lab11;
                {
                    int ret = out_grouping(z, g_v, 97, 249, 1);
                    if (ret < 0) goto lab11;
                    z->c += ret;
                }
                break;
            lab11:
                z->c = v_11;
                if (in_grouping(z, g_v, 97, 249, 0)) goto lab7;
                if (z->c >= z->l) goto lab7;
                z->c++;
            } while (0);
        } while (0);
        i_pV = z->c;
    lab7:
        z->c = v_8;
    }
    {
        int v_12 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 249, 1);
            if (ret < 0) goto lab12;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 249, 1);
            if (ret < 0) goto lab12;
            z->c += ret;
        }
        i_p1 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 249, 1);
            if (ret < 0) goto lab12;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 249, 1);
            if (ret < 0) goto lab12;
            z->c += ret;
        }
        i_p2 = z->c;
    lab12:
        z->c = v_12;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_13 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((33314 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab13;
        if (!find_among_b(z, a_3, 37, 0)) goto lab13;
        z->bra = z->c;
        if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 111 && z->p[z->c - 1] != 114)) goto lab13;
        among_var = find_among_b(z, a_4, 5, 0);
        if (!among_var) goto lab13;
        if (i_pV > z->c) goto lab13;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_9);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab13:
        z->c = z->l - v_13;
    }
    {
        int v_14 = z->l - z->c;
        do {
            int v_15 = z->l - z->c;
            z->ket = z->c;
            among_var = find_among_b(z, a_7, 51, 0);
            if (!among_var) goto lab15;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    if (i_p2 > z->c) goto lab15;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (i_p2 > z->c) goto lab15;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_16 = z->l - z->c;
                        z->ket = z->c;
                        if (!(eq_s_b(z, 2, s_10))) { z->c = z->l - v_16; goto lab16; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_16; goto lab16; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    lab16:
                        ;
                    }
                    break;
                case 3:
                    if (i_p2 > z->c) goto lab15;
                    {
                        int ret = slice_from_s(z, 3, s_11);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    if (i_p2 > z->c) goto lab15;
                    {
                        int ret = slice_from_s(z, 1, s_12);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    if (i_p2 > z->c) goto lab15;
                    {
                        int ret = slice_from_s(z, 4, s_13);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    if (i_pV > z->c) goto lab15;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 7:
                    if (i_p1 > z->c) goto lab15;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_17 = z->l - z->c;
                        z->ket = z->c;
                        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4722696 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->c = z->l - v_17; goto lab17; }
                        among_var = find_among_b(z, a_5, 4, 0);
                        if (!among_var) { z->c = z->l - v_17; goto lab17; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_17; goto lab17; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        switch (among_var) {
                            case 1:
                                z->ket = z->c;
                                if (!(eq_s_b(z, 2, s_14))) { z->c = z->l - v_17; goto lab17; }
                                z->bra = z->c;
                                if (i_p2 > z->c) { z->c = z->l - v_17; goto lab17; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                        }
                    lab17:
                        ;
                    }
                    break;
                case 8:
                    if (i_p2 > z->c) goto lab15;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_18 = z->l - z->c;
                        z->ket = z->c;
                        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4198408 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->c = z->l - v_18; goto lab18; }
                        if (!find_among_b(z, a_6, 3, 0)) { z->c = z->l - v_18; goto lab18; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_18; goto lab18; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    lab18:
                        ;
                    }
                    break;
                case 9:
                    if (i_p2 > z->c) goto lab15;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_19 = z->l - z->c;
                        z->ket = z->c;
                        if (!(eq_s_b(z, 2, s_15))) { z->c = z->l - v_19; goto lab19; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_19; goto lab19; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        z->ket = z->c;
                        if (!(eq_s_b(z, 2, s_16))) { z->c = z->l - v_19; goto lab19; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_19; goto lab19; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    lab19:
                        ;
                    }
                    break;
            }
            break;
        lab15:
            z->c = z->l - v_15;
            {
                int v_20;
                if (z->c < i_pV) goto lab14;
                v_20 = z->lb; z->lb = i_pV;
                z->ket = z->c;
                if (!find_among_b(z, a_8, 87, 0)) { z->lb = v_20; goto lab14; }
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                z->lb = v_20;
            }
        } while (0);
    lab14:
        z->c = z->l - v_14;
    }
    {
        int v_21 = z->l - z->c;
        {
            int v_22 = z->l - z->c;
            z->ket = z->c;
            if (in_grouping_b(z, g_AEIO, 97, 242, 0)) { z->c = z->l - v_22; goto lab21; }
            z->bra = z->c;
            if (i_pV > z->c) { z->c = z->l - v_22; goto lab21; }
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            z->ket = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 'i') { z->c = z->l - v_22; goto lab21; }
            z->c--;
            z->bra = z->c;
            if (i_pV > z->c) { z->c = z->l - v_22; goto lab21; }
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab21:
            ;
        }
        {
            int v_23 = z->l - z->c;
            z->ket = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 'h') { z->c = z->l - v_23; goto lab22; }
            z->c--;
            z->bra = z->c;
            if (in_grouping_b(z, g_CG, 99, 103, 0)) { z->c = z->l - v_23; goto lab22; }
            if (i_pV > z->c) { z->c = z->l - v_23; goto lab22; }
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab22:
            ;
        }
        z->c = z->l - v_21;
    }
    z->c = z->lb;
    {
        int v_24 = z->c;
        while (1) {
            int v_25 = z->c;
            z->bra = z->c;
            if (z->c >= z->l || (z->p[z->c + 0] != 73 && z->p[z->c + 0] != 85)) among_var = 3; else
            among_var = find_among(z, a_2, 3, 0);
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 1, s_17);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 1, s_18);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    if (z->c >= z->l) goto lab24;
                    z->c++;
                    break;
            }
            continue;
        lab24:
            z->c = v_25;
            break;
        }
        z->c = v_24;
    }
    return 1;
}

extern struct SN_env * italian_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
