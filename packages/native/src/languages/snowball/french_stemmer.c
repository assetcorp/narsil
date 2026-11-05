/*
 * Generated from algorithms/french.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "french_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int french_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 'q', 'u' };
static const symbol s_1[] = { 'U' };
static const symbol s_2[] = { 'I' };
static const symbol s_3[] = { 'Y' };
static const symbol s_4[] = { 'H', 'e' };
static const symbol s_5[] = { 'H', 'i' };
static const symbol s_6[] = { 'Y' };
static const symbol s_7[] = { 'U' };
static const symbol s_8[] = { 'i', 'c' };
static const symbol s_9[] = { 'i', 'q', 'U' };
static const symbol s_10[] = { 'l', 'o', 'g' };
static const symbol s_11[] = { 'u' };
static const symbol s_12[] = { 'e', 'n', 't' };
static const symbol s_13[] = { 'a', 't' };
static const symbol s_14[] = { 'e', 'u', 'x' };
static const symbol s_15[] = { 'i' };
static const symbol s_16[] = { 'a', 'b', 'l' };
static const symbol s_17[] = { 'i', 'q', 'U' };
static const symbol s_18[] = { 'a', 't' };
static const symbol s_19[] = { 'i', 'c' };
static const symbol s_20[] = { 'i', 'q', 'U' };
static const symbol s_21[] = { 'e', 'a', 'u' };
static const symbol s_22[] = { 'a', 'l' };
static const symbol s_23[] = { 'o', 'u' };
static const symbol s_24[] = { 'e', 'u', 'x' };
static const symbol s_25[] = { 'a', 'n', 't' };
static const symbol s_26[] = { 'e', 'n', 't' };
static const symbol s_27[] = { 'i' };
static const symbol s_28[] = { 'c' };
static const symbol s_29[] = { 'H', 'i' };
static const symbol s_30[] = { 'i' };
static const symbol s_31[] = { 'e' };
static const symbol s_32[] = { 'i' };
static const symbol s_33[] = { 'u' };
static const symbol s_34[] = { 'y' };
static const symbol s_35[] = { 0xEB };
static const symbol s_36[] = { 0xEF };

static const symbol s_0_0[3] = { 'c', 'o', 'l' };
static const symbol s_0_1[2] = { 'n', 'i' };
static const symbol s_0_2[3] = { 'p', 'a', 'r' };
static const symbol s_0_3[3] = { 't', 'a', 'p' };
static const struct among a_0[4] = {
{ 3, s_0_0, 0, -1, 0},
{ 2, s_0_1, 0, 1, 0},
{ 3, s_0_2, 0, -1, 0},
{ 3, s_0_3, 0, -1, 0}
};

static const symbol s_1_1[1] = { 'H' };
static const symbol s_1_2[2] = { 'H', 'e' };
static const symbol s_1_3[2] = { 'H', 'i' };
static const symbol s_1_4[1] = { 'I' };
static const symbol s_1_5[1] = { 'U' };
static const symbol s_1_6[1] = { 'Y' };
static const struct among a_1[7] = {
{ 0, 0, 0, 7, 0},
{ 1, s_1_1, -1, 6, 0},
{ 2, s_1_2, -1, 4, 0},
{ 2, s_1_3, -2, 5, 0},
{ 1, s_1_4, -4, 1, 0},
{ 1, s_1_5, -5, 2, 0},
{ 1, s_1_6, -6, 3, 0}
};

static const symbol s_2_0[3] = { 'i', 'q', 'U' };
static const symbol s_2_1[3] = { 'a', 'b', 'l' };
static const symbol s_2_2[3] = { 'I', 0xE8, 'r' };
static const symbol s_2_3[3] = { 'i', 0xE8, 'r' };
static const symbol s_2_4[3] = { 'e', 'u', 's' };
static const symbol s_2_5[2] = { 'i', 'v' };
static const struct among a_2[6] = {
{ 3, s_2_0, 0, 3, 0},
{ 3, s_2_1, 0, 3, 0},
{ 3, s_2_2, 0, 4, 0},
{ 3, s_2_3, 0, 4, 0},
{ 3, s_2_4, 0, 2, 0},
{ 2, s_2_5, 0, 1, 0}
};

static const symbol s_3_0[2] = { 'i', 'c' };
static const symbol s_3_1[4] = { 'a', 'b', 'i', 'l' };
static const symbol s_3_2[2] = { 'i', 'v' };
static const struct among a_3[3] = {
{ 2, s_3_0, 0, 2, 0},
{ 4, s_3_1, 0, 1, 0},
{ 2, s_3_2, 0, 3, 0}
};

static const symbol s_4_0[4] = { 'i', 'q', 'U', 'e' };
static const symbol s_4_1[6] = { 'a', 't', 'r', 'i', 'c', 'e' };
static const symbol s_4_2[4] = { 'a', 'n', 'c', 'e' };
static const symbol s_4_3[4] = { 'e', 'n', 'c', 'e' };
static const symbol s_4_4[5] = { 'l', 'o', 'g', 'i', 'e' };
static const symbol s_4_5[4] = { 'a', 'b', 'l', 'e' };
static const symbol s_4_6[4] = { 'i', 's', 'm', 'e' };
static const symbol s_4_7[4] = { 'e', 'u', 's', 'e' };
static const symbol s_4_8[4] = { 'i', 's', 't', 'e' };
static const symbol s_4_9[3] = { 'i', 'v', 'e' };
static const symbol s_4_10[2] = { 'i', 'f' };
static const symbol s_4_11[5] = { 'u', 's', 'i', 'o', 'n' };
static const symbol s_4_12[5] = { 'a', 't', 'i', 'o', 'n' };
static const symbol s_4_13[5] = { 'u', 't', 'i', 'o', 'n' };
static const symbol s_4_14[5] = { 'a', 't', 'e', 'u', 'r' };
static const symbol s_4_15[5] = { 'i', 'q', 'U', 'e', 's' };
static const symbol s_4_16[7] = { 'a', 't', 'r', 'i', 'c', 'e', 's' };
static const symbol s_4_17[5] = { 'a', 'n', 'c', 'e', 's' };
static const symbol s_4_18[5] = { 'e', 'n', 'c', 'e', 's' };
static const symbol s_4_19[6] = { 'l', 'o', 'g', 'i', 'e', 's' };
static const symbol s_4_20[5] = { 'a', 'b', 'l', 'e', 's' };
static const symbol s_4_21[5] = { 'i', 's', 'm', 'e', 's' };
static const symbol s_4_22[5] = { 'e', 'u', 's', 'e', 's' };
static const symbol s_4_23[5] = { 'i', 's', 't', 'e', 's' };
static const symbol s_4_24[4] = { 'i', 'v', 'e', 's' };
static const symbol s_4_25[3] = { 'i', 'f', 's' };
static const symbol s_4_26[6] = { 'u', 's', 'i', 'o', 'n', 's' };
static const symbol s_4_27[6] = { 'a', 't', 'i', 'o', 'n', 's' };
static const symbol s_4_28[6] = { 'u', 't', 'i', 'o', 'n', 's' };
static const symbol s_4_29[6] = { 'a', 't', 'e', 'u', 'r', 's' };
static const symbol s_4_30[5] = { 'm', 'e', 'n', 't', 's' };
static const symbol s_4_31[6] = { 'e', 'm', 'e', 'n', 't', 's' };
static const symbol s_4_32[9] = { 'i', 's', 's', 'e', 'm', 'e', 'n', 't', 's' };
static const symbol s_4_33[4] = { 'i', 't', 0xE9, 's' };
static const symbol s_4_34[4] = { 'm', 'e', 'n', 't' };
static const symbol s_4_35[5] = { 'e', 'm', 'e', 'n', 't' };
static const symbol s_4_36[8] = { 'i', 's', 's', 'e', 'm', 'e', 'n', 't' };
static const symbol s_4_37[6] = { 'a', 'm', 'm', 'e', 'n', 't' };
static const symbol s_4_38[6] = { 'e', 'm', 'm', 'e', 'n', 't' };
static const symbol s_4_39[3] = { 'a', 'u', 'x' };
static const symbol s_4_40[4] = { 'e', 'a', 'u', 'x' };
static const symbol s_4_41[3] = { 'e', 'u', 'x' };
static const symbol s_4_42[3] = { 'o', 'u', 'x' };
static const symbol s_4_43[3] = { 'i', 't', 0xE9 };
static const struct among a_4[44] = {
{ 4, s_4_0, 0, 1, 0},
{ 6, s_4_1, 0, 2, 0},
{ 4, s_4_2, 0, 1, 0},
{ 4, s_4_3, 0, 5, 0},
{ 5, s_4_4, 0, 3, 0},
{ 4, s_4_5, 0, 1, 0},
{ 4, s_4_6, 0, 1, 0},
{ 4, s_4_7, 0, 12, 0},
{ 4, s_4_8, 0, 1, 0},
{ 3, s_4_9, 0, 8, 0},
{ 2, s_4_10, 0, 8, 0},
{ 5, s_4_11, 0, 4, 0},
{ 5, s_4_12, 0, 2, 0},
{ 5, s_4_13, 0, 4, 0},
{ 5, s_4_14, 0, 2, 0},
{ 5, s_4_15, 0, 1, 0},
{ 7, s_4_16, 0, 2, 0},
{ 5, s_4_17, 0, 1, 0},
{ 5, s_4_18, 0, 5, 0},
{ 6, s_4_19, 0, 3, 0},
{ 5, s_4_20, 0, 1, 0},
{ 5, s_4_21, 0, 1, 0},
{ 5, s_4_22, 0, 12, 0},
{ 5, s_4_23, 0, 1, 0},
{ 4, s_4_24, 0, 8, 0},
{ 3, s_4_25, 0, 8, 0},
{ 6, s_4_26, 0, 4, 0},
{ 6, s_4_27, 0, 2, 0},
{ 6, s_4_28, 0, 4, 0},
{ 6, s_4_29, 0, 2, 0},
{ 5, s_4_30, 0, 16, 0},
{ 6, s_4_31, -1, 6, 0},
{ 9, s_4_32, -1, 13, 0},
{ 4, s_4_33, 0, 7, 0},
{ 4, s_4_34, 0, 16, 0},
{ 5, s_4_35, -1, 6, 0},
{ 8, s_4_36, -1, 13, 0},
{ 6, s_4_37, -3, 14, 0},
{ 6, s_4_38, -4, 15, 0},
{ 3, s_4_39, 0, 10, 0},
{ 4, s_4_40, -1, 9, 0},
{ 3, s_4_41, 0, 1, 0},
{ 3, s_4_42, 0, 11, 0},
{ 3, s_4_43, 0, 7, 0}
};

static const symbol s_5_0[3] = { 'i', 'r', 'a' };
static const symbol s_5_1[2] = { 'i', 'e' };
static const symbol s_5_2[4] = { 'i', 's', 's', 'e' };
static const symbol s_5_3[7] = { 'i', 's', 's', 'a', 'n', 't', 'e' };
static const symbol s_5_4[1] = { 'i' };
static const symbol s_5_5[4] = { 'i', 'r', 'a', 'i' };
static const symbol s_5_6[2] = { 'i', 'r' };
static const symbol s_5_7[4] = { 'i', 'r', 'a', 's' };
static const symbol s_5_8[3] = { 'i', 'e', 's' };
static const symbol s_5_9[4] = { 0xEE, 'm', 'e', 's' };
static const symbol s_5_10[5] = { 'i', 's', 's', 'e', 's' };
static const symbol s_5_11[8] = { 'i', 's', 's', 'a', 'n', 't', 'e', 's' };
static const symbol s_5_12[4] = { 0xEE, 't', 'e', 's' };
static const symbol s_5_13[2] = { 'i', 's' };
static const symbol s_5_14[5] = { 'i', 'r', 'a', 'i', 's' };
static const symbol s_5_15[6] = { 'i', 's', 's', 'a', 'i', 's' };
static const symbol s_5_16[6] = { 'i', 'r', 'i', 'o', 'n', 's' };
static const symbol s_5_17[7] = { 'i', 's', 's', 'i', 'o', 'n', 's' };
static const symbol s_5_18[5] = { 'i', 'r', 'o', 'n', 's' };
static const symbol s_5_19[6] = { 'i', 's', 's', 'o', 'n', 's' };
static const symbol s_5_20[7] = { 'i', 's', 's', 'a', 'n', 't', 's' };
static const symbol s_5_21[2] = { 'i', 't' };
static const symbol s_5_22[5] = { 'i', 'r', 'a', 'i', 't' };
static const symbol s_5_23[6] = { 'i', 's', 's', 'a', 'i', 't' };
static const symbol s_5_24[6] = { 'i', 's', 's', 'a', 'n', 't' };
static const symbol s_5_25[7] = { 'i', 'r', 'a', 'I', 'e', 'n', 't' };
static const symbol s_5_26[8] = { 'i', 's', 's', 'a', 'I', 'e', 'n', 't' };
static const symbol s_5_27[5] = { 'i', 'r', 'e', 'n', 't' };
static const symbol s_5_28[6] = { 'i', 's', 's', 'e', 'n', 't' };
static const symbol s_5_29[5] = { 'i', 'r', 'o', 'n', 't' };
static const symbol s_5_30[2] = { 0xEE, 't' };
static const symbol s_5_31[5] = { 'i', 'r', 'i', 'e', 'z' };
static const symbol s_5_32[6] = { 'i', 's', 's', 'i', 'e', 'z' };
static const symbol s_5_33[4] = { 'i', 'r', 'e', 'z' };
static const symbol s_5_34[5] = { 'i', 's', 's', 'e', 'z' };
static const struct among a_5[35] = {
{ 3, s_5_0, 0, 1, 0},
{ 2, s_5_1, 0, 1, 0},
{ 4, s_5_2, 0, 1, 0},
{ 7, s_5_3, 0, 1, 0},
{ 1, s_5_4, 0, 1, 0},
{ 4, s_5_5, -1, 1, 0},
{ 2, s_5_6, 0, 1, 0},
{ 4, s_5_7, 0, 1, 0},
{ 3, s_5_8, 0, 1, 0},
{ 4, s_5_9, 0, 1, 0},
{ 5, s_5_10, 0, 1, 0},
{ 8, s_5_11, 0, 1, 0},
{ 4, s_5_12, 0, 1, 0},
{ 2, s_5_13, 0, 1, 0},
{ 5, s_5_14, -1, 1, 0},
{ 6, s_5_15, -2, 1, 0},
{ 6, s_5_16, 0, 1, 0},
{ 7, s_5_17, 0, 1, 0},
{ 5, s_5_18, 0, 1, 0},
{ 6, s_5_19, 0, 1, 0},
{ 7, s_5_20, 0, 1, 0},
{ 2, s_5_21, 0, 1, 0},
{ 5, s_5_22, -1, 1, 0},
{ 6, s_5_23, -2, 1, 0},
{ 6, s_5_24, 0, 1, 0},
{ 7, s_5_25, 0, 1, 0},
{ 8, s_5_26, 0, 1, 0},
{ 5, s_5_27, 0, 1, 0},
{ 6, s_5_28, 0, 1, 0},
{ 5, s_5_29, 0, 1, 0},
{ 2, s_5_30, 0, 1, 0},
{ 5, s_5_31, 0, 1, 0},
{ 6, s_5_32, 0, 1, 0},
{ 4, s_5_33, 0, 1, 0},
{ 5, s_5_34, 0, 1, 0}
};

static const symbol s_6_0[2] = { 'a', 'l' };
static const symbol s_6_1[3] = { 0xE9, 'p', 'l' };
static const symbol s_6_2[3] = { 'a', 'u', 'v' };
static const struct among a_6[3] = {
{ 2, s_6_0, 0, 1, 0},
{ 3, s_6_1, 0, -1, 0},
{ 3, s_6_2, 0, -1, 0}
};

static const symbol s_7_0[1] = { 'a' };
static const symbol s_7_1[3] = { 'e', 'r', 'a' };
static const symbol s_7_2[4] = { 'a', 'i', 's', 'e' };
static const symbol s_7_3[4] = { 'a', 's', 's', 'e' };
static const symbol s_7_4[4] = { 'a', 'n', 't', 'e' };
static const symbol s_7_5[2] = { 0xE9, 'e' };
static const symbol s_7_6[2] = { 'a', 'i' };
static const symbol s_7_7[4] = { 'e', 'r', 'a', 'i' };
static const symbol s_7_8[2] = { 'e', 'r' };
static const symbol s_7_9[2] = { 'a', 's' };
static const symbol s_7_10[4] = { 'e', 'r', 'a', 's' };
static const symbol s_7_11[4] = { 0xE2, 'm', 'e', 's' };
static const symbol s_7_12[5] = { 'a', 'i', 's', 'e', 's' };
static const symbol s_7_13[5] = { 'a', 's', 's', 'e', 's' };
static const symbol s_7_14[5] = { 'a', 'n', 't', 'e', 's' };
static const symbol s_7_15[4] = { 0xE2, 't', 'e', 's' };
static const symbol s_7_16[3] = { 0xE9, 'e', 's' };
static const symbol s_7_17[3] = { 'a', 'i', 's' };
static const symbol s_7_18[4] = { 'e', 'a', 'i', 's' };
static const symbol s_7_19[5] = { 'e', 'r', 'a', 'i', 's' };
static const symbol s_7_20[4] = { 'i', 'o', 'n', 's' };
static const symbol s_7_21[6] = { 'e', 'r', 'i', 'o', 'n', 's' };
static const symbol s_7_22[7] = { 'a', 's', 's', 'i', 'o', 'n', 's' };
static const symbol s_7_23[5] = { 'e', 'r', 'o', 'n', 's' };
static const symbol s_7_24[4] = { 'a', 'n', 't', 's' };
static const symbol s_7_25[2] = { 0xE9, 's' };
static const symbol s_7_26[3] = { 'a', 'i', 't' };
static const symbol s_7_27[5] = { 'e', 'r', 'a', 'i', 't' };
static const symbol s_7_28[3] = { 'a', 'n', 't' };
static const symbol s_7_29[5] = { 'a', 'I', 'e', 'n', 't' };
static const symbol s_7_30[7] = { 'e', 'r', 'a', 'I', 'e', 'n', 't' };
static const symbol s_7_31[5] = { 0xE8, 'r', 'e', 'n', 't' };
static const symbol s_7_32[6] = { 'a', 's', 's', 'e', 'n', 't' };
static const symbol s_7_33[5] = { 'e', 'r', 'o', 'n', 't' };
static const symbol s_7_34[2] = { 0xE2, 't' };
static const symbol s_7_35[2] = { 'e', 'z' };
static const symbol s_7_36[3] = { 'i', 'e', 'z' };
static const symbol s_7_37[5] = { 'e', 'r', 'i', 'e', 'z' };
static const symbol s_7_38[6] = { 'a', 's', 's', 'i', 'e', 'z' };
static const symbol s_7_39[4] = { 'e', 'r', 'e', 'z' };
static const symbol s_7_40[1] = { 0xE9 };
static const struct among a_7[41] = {
{ 1, s_7_0, 0, 3, 0},
{ 3, s_7_1, -1, 2, 0},
{ 4, s_7_2, 0, 4, 0},
{ 4, s_7_3, 0, 3, 0},
{ 4, s_7_4, 0, 3, 0},
{ 2, s_7_5, 0, 2, 0},
{ 2, s_7_6, 0, 3, 0},
{ 4, s_7_7, -1, 2, 0},
{ 2, s_7_8, 0, 2, 0},
{ 2, s_7_9, 0, 3, 0},
{ 4, s_7_10, -1, 2, 0},
{ 4, s_7_11, 0, 3, 0},
{ 5, s_7_12, 0, 4, 0},
{ 5, s_7_13, 0, 3, 0},
{ 5, s_7_14, 0, 3, 0},
{ 4, s_7_15, 0, 3, 0},
{ 3, s_7_16, 0, 2, 0},
{ 3, s_7_17, 0, 4, 0},
{ 4, s_7_18, -1, 2, 0},
{ 5, s_7_19, -2, 2, 0},
{ 4, s_7_20, 0, 1, 0},
{ 6, s_7_21, -1, 2, 0},
{ 7, s_7_22, -2, 3, 0},
{ 5, s_7_23, 0, 2, 0},
{ 4, s_7_24, 0, 3, 0},
{ 2, s_7_25, 0, 2, 0},
{ 3, s_7_26, 0, 3, 0},
{ 5, s_7_27, -1, 2, 0},
{ 3, s_7_28, 0, 3, 0},
{ 5, s_7_29, 0, 3, 0},
{ 7, s_7_30, -1, 2, 0},
{ 5, s_7_31, 0, 2, 0},
{ 6, s_7_32, 0, 3, 0},
{ 5, s_7_33, 0, 2, 0},
{ 2, s_7_34, 0, 3, 0},
{ 2, s_7_35, 0, 2, 0},
{ 3, s_7_36, -1, 2, 0},
{ 5, s_7_37, -1, 2, 0},
{ 6, s_7_38, -2, 3, 0},
{ 4, s_7_39, -4, 2, 0},
{ 1, s_7_40, 0, 2, 0}
};

static const symbol s_8_0[1] = { 'e' };
static const symbol s_8_1[4] = { 'I', 0xE8, 'r', 'e' };
static const symbol s_8_2[4] = { 'i', 0xE8, 'r', 'e' };
static const symbol s_8_3[3] = { 'i', 'o', 'n' };
static const symbol s_8_4[3] = { 'I', 'e', 'r' };
static const symbol s_8_5[3] = { 'i', 'e', 'r' };
static const struct among a_8[6] = {
{ 1, s_8_0, 0, 3, 0},
{ 4, s_8_1, -1, 2, 0},
{ 4, s_8_2, -2, 2, 0},
{ 3, s_8_3, 0, 1, 0},
{ 3, s_8_4, 0, 2, 0},
{ 3, s_8_5, 0, 2, 0}
};

static const symbol s_9_0[3] = { 'e', 'l', 'l' };
static const symbol s_9_1[4] = { 'e', 'i', 'l', 'l' };
static const symbol s_9_2[3] = { 'e', 'n', 'n' };
static const symbol s_9_3[3] = { 'o', 'n', 'n' };
static const symbol s_9_4[3] = { 'e', 't', 't' };
static const struct among a_9[5] = {
{ 3, s_9_0, 0, -1, 0},
{ 4, s_9_1, 0, -1, 0},
{ 3, s_9_2, 0, -1, 0},
{ 3, s_9_3, 0, -1, 0},
{ 3, s_9_4, 0, -1, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 130, 103, 8, 5 };

static const unsigned char g_oux_ending[] = { 65, 85 };

static const unsigned char g_elision_char[] = { 131, 14, 3 };

static const unsigned char g_keep_with_s[] = { 1, 65, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128 };

extern int french_stem(struct SN_env * z) {
    int among_var;
    int i_p2;
    int i_p1;
    int i_pV;
    {
        int v_1 = z->c;
        z->bra = z->c;
        do {
            if (in_grouping(z, g_elision_char, 99, 116, 0)) goto lab1;
            break;
        lab1:
            if (!(eq_s(z, 2, s_0))) goto lab0;
        } while (0);
        if (z->c == z->l || z->p[z->c] != '\'') goto lab0;
        z->c++;
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
        while (1) {
            int v_3 = z->c;
            while (1) {
                int v_4 = z->c;
                do {
                    int v_5 = z->c;
                    if (in_grouping(z, g_v, 97, 251, 0)) goto lab5;
                    z->bra = z->c;
                    do {
                        int v_6 = z->c;
                        if (z->c == z->l || z->p[z->c] != 'u') goto lab6;
                        z->c++;
                        z->ket = z->c;
                        if (in_grouping(z, g_v, 97, 251, 0)) goto lab6;
                        {
                            int ret = slice_from_s(z, 1, s_1);
                            if (ret < 0) return ret;
                        }
                        break;
                    lab6:
                        z->c = v_6;
                        if (z->c == z->l || z->p[z->c] != 'i') goto lab7;
                        z->c++;
                        z->ket = z->c;
                        if (in_grouping(z, g_v, 97, 251, 0)) goto lab7;
                        {
                            int ret = slice_from_s(z, 1, s_2);
                            if (ret < 0) return ret;
                        }
                        break;
                    lab7:
                        z->c = v_6;
                        if (z->c == z->l || z->p[z->c] != 'y') goto lab5;
                        z->c++;
                        z->ket = z->c;
                        {
                            int ret = slice_from_s(z, 1, s_3);
                            if (ret < 0) return ret;
                        }
                    } while (0);
                    break;
                lab5:
                    z->c = v_5;
                    z->bra = z->c;
                    if (z->c == z->l || z->p[z->c] != 0xEB) goto lab8;
                    z->c++;
                    z->ket = z->c;
                    {
                        int ret = slice_from_s(z, 2, s_4);
                        if (ret < 0) return ret;
                    }
                    break;
                lab8:
                    z->c = v_5;
                    z->bra = z->c;
                    if (z->c == z->l || z->p[z->c] != 0xEF) goto lab9;
                    z->c++;
                    z->ket = z->c;
                    {
                        int ret = slice_from_s(z, 2, s_5);
                        if (ret < 0) return ret;
                    }
                    break;
                lab9:
                    z->c = v_5;
                    z->bra = z->c;
                    if (z->c == z->l || z->p[z->c] != 'y') goto lab10;
                    z->c++;
                    z->ket = z->c;
                    if (in_grouping(z, g_v, 97, 251, 0)) goto lab10;
                    {
                        int ret = slice_from_s(z, 1, s_6);
                        if (ret < 0) return ret;
                    }
                    break;
                lab10:
                    z->c = v_5;
                    if (z->c == z->l || z->p[z->c] != 'q') goto lab4;
                    z->c++;
                    z->bra = z->c;
                    if (z->c == z->l || z->p[z->c] != 'u') goto lab4;
                    z->c++;
                    z->ket = z->c;
                    {
                        int ret = slice_from_s(z, 1, s_7);
                        if (ret < 0) return ret;
                    }
                } while (0);
                z->c = v_4;
                break;
            lab4:
                z->c = v_4;
                if (z->c >= z->l) goto lab3;
                z->c++;
            }
            continue;
        lab3:
            z->c = v_3;
            break;
        }
        z->c = v_2;
    }
    i_pV = z->l;
    i_p1 = z->l;
    i_p2 = z->l;
    {
        int v_7 = z->c;
        do {
            int v_8 = z->c;
            if (in_grouping(z, g_v, 97, 251, 0)) goto lab13;
            if (in_grouping(z, g_v, 97, 251, 0)) goto lab13;
            if (z->c >= z->l) goto lab13;
            z->c++;
            break;
        lab13:
            z->c = v_8;
            if (z->c + 1 >= z->l || z->p[z->c + 1] >> 5 != 3 || !((33282 >> (z->p[z->c + 1] & 0x1f)) & 1)) goto lab14;
            among_var = find_among(z, a_0, 4, 0);
            if (!among_var) goto lab14;
            switch (among_var) {
                case 1:
                    if (in_grouping(z, g_v, 97, 251, 0)) goto lab14;
                    break;
            }
            break;
        lab14:
            z->c = v_8;
            if (z->c >= z->l) goto lab12;
            z->c++;
            {
                int ret = out_grouping(z, g_v, 97, 251, 1);
                if (ret < 0) goto lab12;
                z->c += ret;
            }
        } while (0);
        i_pV = z->c;
    lab12:
        z->c = v_7;
    }
    {
        int v_9 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 251, 1);
            if (ret < 0) goto lab15;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 251, 1);
            if (ret < 0) goto lab15;
            z->c += ret;
        }
        i_p1 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 251, 1);
            if (ret < 0) goto lab15;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 251, 1);
            if (ret < 0) goto lab15;
            z->c += ret;
        }
        i_p2 = z->c;
    lab15:
        z->c = v_9;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_10 = z->l - z->c;
        do {
            int v_11 = z->l - z->c;
            {
                int v_12 = z->l - z->c;
                do {
                    int v_13 = z->l - z->c;
                    z->ket = z->c;
                    among_var = find_among_b(z, a_4, 44, 0);
                    if (!among_var) goto lab18;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            if (i_p2 > z->c) goto lab18;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            if (i_p2 > z->c) goto lab18;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_14 = z->l - z->c;
                                z->ket = z->c;
                                if (!(eq_s_b(z, 2, s_8))) { z->c = z->l - v_14; goto lab19; }
                                z->bra = z->c;
                                do {
                                    int v_15 = z->l - z->c;
                                    if (i_p2 > z->c) goto lab20;
                                    {
                                        int ret = slice_del(z);
                                        if (ret < 0) return ret;
                                    }
                                    break;
                                lab20:
                                    z->c = z->l - v_15;
                                    {
                                        int ret = slice_from_s(z, 3, s_9);
                                        if (ret < 0) return ret;
                                    }
                                } while (0);
                            lab19:
                                ;
                            }
                            break;
                        case 3:
                            if (i_p2 > z->c) goto lab18;
                            {
                                int ret = slice_from_s(z, 3, s_10);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 4:
                            if (i_p2 > z->c) goto lab18;
                            {
                                int ret = slice_from_s(z, 1, s_11);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 5:
                            if (i_p2 > z->c) goto lab18;
                            {
                                int ret = slice_from_s(z, 3, s_12);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 6:
                            if (i_pV > z->c) goto lab18;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_16 = z->l - z->c;
                                z->ket = z->c;
                                among_var = find_among_b(z, a_2, 6, 0);
                                if (!among_var) { z->c = z->l - v_16; goto lab21; }
                                z->bra = z->c;
                                switch (among_var) {
                                    case 1:
                                        if (i_p2 > z->c) { z->c = z->l - v_16; goto lab21; }
                                        {
                                            int ret = slice_del(z);
                                            if (ret < 0) return ret;
                                        }
                                        z->ket = z->c;
                                        if (!(eq_s_b(z, 2, s_13))) { z->c = z->l - v_16; goto lab21; }
                                        z->bra = z->c;
                                        if (i_p2 > z->c) { z->c = z->l - v_16; goto lab21; }
                                        {
                                            int ret = slice_del(z);
                                            if (ret < 0) return ret;
                                        }
                                        break;
                                    case 2:
                                        do {
                                            int v_17 = z->l - z->c;
                                            if (i_p2 > z->c) goto lab22;
                                            {
                                                int ret = slice_del(z);
                                                if (ret < 0) return ret;
                                            }
                                            break;
                                        lab22:
                                            z->c = z->l - v_17;
                                            if (i_p1 > z->c) { z->c = z->l - v_16; goto lab21; }
                                            {
                                                int ret = slice_from_s(z, 3, s_14);
                                                if (ret < 0) return ret;
                                            }
                                        } while (0);
                                        break;
                                    case 3:
                                        if (i_p2 > z->c) { z->c = z->l - v_16; goto lab21; }
                                        {
                                            int ret = slice_del(z);
                                            if (ret < 0) return ret;
                                        }
                                        break;
                                    case 4:
                                        if (i_pV > z->c) { z->c = z->l - v_16; goto lab21; }
                                        {
                                            int ret = slice_from_s(z, 1, s_15);
                                            if (ret < 0) return ret;
                                        }
                                        break;
                                }
                            lab21:
                                ;
                            }
                            break;
                        case 7:
                            if (i_p2 > z->c) goto lab18;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_18 = z->l - z->c;
                                z->ket = z->c;
                                if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4198408 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->c = z->l - v_18; goto lab23; }
                                among_var = find_among_b(z, a_3, 3, 0);
                                if (!among_var) { z->c = z->l - v_18; goto lab23; }
                                z->bra = z->c;
                                switch (among_var) {
                                    case 1:
                                        do {
                                            int v_19 = z->l - z->c;
                                            if (i_p2 > z->c) goto lab24;
                                            {
                                                int ret = slice_del(z);
                                                if (ret < 0) return ret;
                                            }
                                            break;
                                        lab24:
                                            z->c = z->l - v_19;
                                            {
                                                int ret = slice_from_s(z, 3, s_16);
                                                if (ret < 0) return ret;
                                            }
                                        } while (0);
                                        break;
                                    case 2:
                                        do {
                                            int v_20 = z->l - z->c;
                                            if (i_p2 > z->c) goto lab25;
                                            {
                                                int ret = slice_del(z);
                                                if (ret < 0) return ret;
                                            }
                                            break;
                                        lab25:
                                            z->c = z->l - v_20;
                                            {
                                                int ret = slice_from_s(z, 3, s_17);
                                                if (ret < 0) return ret;
                                            }
                                        } while (0);
                                        break;
                                    case 3:
                                        if (i_p2 > z->c) { z->c = z->l - v_18; goto lab23; }
                                        {
                                            int ret = slice_del(z);
                                            if (ret < 0) return ret;
                                        }
                                        break;
                                }
                            lab23:
                                ;
                            }
                            break;
                        case 8:
                            if (i_p2 > z->c) goto lab18;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_21 = z->l - z->c;
                                z->ket = z->c;
                                if (!(eq_s_b(z, 2, s_18))) { z->c = z->l - v_21; goto lab26; }
                                z->bra = z->c;
                                if (i_p2 > z->c) { z->c = z->l - v_21; goto lab26; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                z->ket = z->c;
                                if (!(eq_s_b(z, 2, s_19))) { z->c = z->l - v_21; goto lab26; }
                                z->bra = z->c;
                                do {
                                    int v_22 = z->l - z->c;
                                    if (i_p2 > z->c) goto lab27;
                                    {
                                        int ret = slice_del(z);
                                        if (ret < 0) return ret;
                                    }
                                    break;
                                lab27:
                                    z->c = z->l - v_22;
                                    {
                                        int ret = slice_from_s(z, 3, s_20);
                                        if (ret < 0) return ret;
                                    }
                                } while (0);
                            lab26:
                                ;
                            }
                            break;
                        case 9:
                            {
                                int ret = slice_from_s(z, 3, s_21);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 10:
                            if (i_p1 > z->c) goto lab18;
                            {
                                int ret = slice_from_s(z, 2, s_22);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 11:
                            if (in_grouping_b(z, g_oux_ending, 98, 112, 0)) goto lab18;
                            {
                                int ret = slice_from_s(z, 2, s_23);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 12:
                            do {
                                int v_23 = z->l - z->c;
                                if (i_p2 > z->c) goto lab28;
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                            lab28:
                                z->c = z->l - v_23;
                                if (i_p1 > z->c) goto lab18;
                                {
                                    int ret = slice_from_s(z, 3, s_24);
                                    if (ret < 0) return ret;
                                }
                            } while (0);
                            break;
                        case 13:
                            if (i_p1 > z->c) goto lab18;
                            if (out_grouping_b(z, g_v, 97, 251, 0)) goto lab18;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 14:
                            if (i_pV > z->c) goto lab18;
                            {
                                int ret = slice_from_s(z, 3, s_25);
                                if (ret < 0) return ret;
                            }
                            goto lab18;
                            break;
                        case 15:
                            if (i_pV > z->c) goto lab18;
                            {
                                int ret = slice_from_s(z, 3, s_26);
                                if (ret < 0) return ret;
                            }
                            goto lab18;
                            break;
                        case 16:
                            {
                                int v_24 = z->l - z->c;
                                if (in_grouping_b(z, g_v, 97, 251, 0)) goto lab18;
                                if (i_pV > z->c) goto lab18;
                                z->c = z->l - v_24;
                            }
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            goto lab18;
                            break;
                    }
                    break;
                lab18:
                    z->c = z->l - v_13;
                    {
                        int v_25;
                        if (z->c < i_pV) goto lab29;
                        v_25 = z->lb; z->lb = i_pV;
                        z->ket = z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((68944418 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->lb = v_25; goto lab29; }
                        if (!find_among_b(z, a_5, 35, 0)) { z->lb = v_25; goto lab29; }
                        z->bra = z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] != 'H') goto lab30;
                        z->c--;
                        { z->lb = v_25; goto lab29; }
                    lab30:
                        if (out_grouping_b(z, g_v, 97, 251, 0)) { z->lb = v_25; goto lab29; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        z->lb = v_25;
                    }
                    break;
                lab29:
                    z->c = z->l - v_13;
                    {
                        int v_26;
                        if (z->c < i_pV) goto lab17;
                        v_26 = z->lb; z->lb = i_pV;
                        z->ket = z->c;
                        among_var = find_among_b(z, a_7, 41, 0);
                        if (!among_var) { z->lb = v_26; goto lab17; }
                        z->bra = z->c;
                        z->lb = v_26;
                    }
                    switch (among_var) {
                        case 1:
                            if (i_p2 > z->c) goto lab17;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 3:
                            {
                                int v_27 = z->l - z->c;
                                if (z->c <= z->lb || z->p[z->c - 1] != 'e') { z->c = z->l - v_27; goto lab31; }
                                z->c--;
                                if (i_pV > z->c) { z->c = z->l - v_27; goto lab31; }
                                z->bra = z->c;
                            lab31:
                                ;
                            }
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 4:
                            {
                                int v_28 = z->l - z->c;
                                if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 108 && z->p[z->c - 1] != 118)) goto lab32;
                                among_var = find_among_b(z, a_6, 3, 0);
                                if (!among_var) goto lab32;
                                switch (among_var) {
                                    case 1:
                                        if (z->c <= z->lb) goto lab32;
                                        z->c--;
                                        if (z->c > z->lb) goto lab32;
                                        break;
                                }
                                goto lab17;
                            lab32:
                                z->c = z->l - v_28;
                            }
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                    }
                } while (0);
                z->c = z->l - v_12;
                {
                    int v_29 = z->l - z->c;
                    z->ket = z->c;
                    do {
                        int v_30 = z->l - z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] != 'Y') goto lab34;
                        z->c--;
                        z->bra = z->c;
                        {
                            int ret = slice_from_s(z, 1, s_27);
                            if (ret < 0) return ret;
                        }
                        break;
                    lab34:
                        z->c = z->l - v_30;
                        if (z->c <= z->lb || z->p[z->c - 1] != 0xE7) { z->c = z->l - v_29; goto lab33; }
                        z->c--;
                        z->bra = z->c;
                        {
                            int ret = slice_from_s(z, 1, s_28);
                            if (ret < 0) return ret;
                        }
                    } while (0);
                lab33:
                    ;
                }
            }
            break;
        lab17:
            z->c = z->l - v_11;
            {
                int v_31 = z->l - z->c;
                z->ket = z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 's') { z->c = z->l - v_31; goto lab35; }
                z->c--;
                z->bra = z->c;
                {
                    int v_32 = z->l - z->c;
                    do {
                        if (!(eq_s_b(z, 2, s_29))) goto lab36;
                        break;
                    lab36:
                        if (out_grouping_b(z, g_keep_with_s, 97, 232, 0)) { z->c = z->l - v_31; goto lab35; }
                    } while (0);
                    z->c = z->l - v_32;
                }
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
            lab35:
                ;
            }
            {
                int v_33;
                if (z->c < i_pV) goto lab16;
                v_33 = z->lb; z->lb = i_pV;
                z->ket = z->c;
                if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((278560 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->lb = v_33; goto lab16; }
                among_var = find_among_b(z, a_8, 6, 0);
                if (!among_var) { z->lb = v_33; goto lab16; }
                z->bra = z->c;
                switch (among_var) {
                    case 1:
                        if (i_p2 > z->c) { z->lb = v_33; goto lab16; }
                        do {
                            if (z->c <= z->lb || z->p[z->c - 1] != 's') goto lab37;
                            z->c--;
                            break;
                        lab37:
                            if (z->c <= z->lb || z->p[z->c - 1] != 't') { z->lb = v_33; goto lab16; }
                            z->c--;
                        } while (0);
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 2:
                        {
                            int ret = slice_from_s(z, 1, s_30);
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
                z->lb = v_33;
            }
        } while (0);
    lab16:
        z->c = z->l - v_10;
    }
    {
        int v_34 = z->l - z->c;
        {
            int v_35 = z->l - z->c;
            if (z->c - 2 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1069056 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab38;
            if (!find_among_b(z, a_9, 5, 0)) goto lab38;
            z->c = z->l - v_35;
        }
        z->ket = z->c;
        if (z->c <= z->lb) goto lab38;
        z->c--;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab38:
        z->c = z->l - v_34;
    }
    {
        int v_36 = z->l - z->c;
        {
            int v_37 = 1;
            while (1) {
                if (out_grouping_b(z, g_v, 97, 251, 0)) goto lab40;
                v_37--;
                continue;
            lab40:
                break;
            }
            if (v_37 > 0) goto lab39;
        }
        z->ket = z->c;
        do {
            if (z->c <= z->lb || z->p[z->c - 1] != 0xE9) goto lab41;
            z->c--;
            break;
        lab41:
            if (z->c <= z->lb || z->p[z->c - 1] != 0xE8) goto lab39;
            z->c--;
        } while (0);
        z->bra = z->c;
        {
            int ret = slice_from_s(z, 1, s_31);
            if (ret < 0) return ret;
        }
    lab39:
        z->c = z->l - v_36;
    }
    z->c = z->lb;
    {
        int v_38 = z->c;
        while (1) {
            int v_39 = z->c;
            z->bra = z->c;
            if (z->c >= z->l || z->p[z->c + 0] >> 5 != 2 || !((35652352 >> (z->p[z->c + 0] & 0x1f)) & 1)) among_var = 7; else
            among_var = find_among(z, a_1, 7, 0);
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 1, s_32);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 1, s_33);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    {
                        int ret = slice_from_s(z, 1, s_34);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    {
                        int ret = slice_from_s(z, 1, s_35);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    {
                        int ret = slice_from_s(z, 1, s_36);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 7:
                    if (z->c >= z->l) goto lab43;
                    z->c++;
                    break;
            }
            continue;
        lab43:
            z->c = v_39;
            break;
        }
        z->c = v_38;
    }
    return 1;
}

extern struct SN_env * french_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
