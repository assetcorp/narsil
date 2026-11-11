/*
 * Generated from algorithms/hungarian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "hungarian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int hungarian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_double(struct SN_env * z);
static int r_undouble(struct SN_env * z);

static const symbol s_0[] = { 'a' };
static const symbol s_1[] = { 'e' };
static const symbol s_2[] = { 'e' };
static const symbol s_3[] = { 'a' };
static const symbol s_4[] = { 'a' };
static const symbol s_5[] = { 'e' };
static const symbol s_6[] = { 'e' };
static const symbol s_7[] = { 'a' };
static const symbol s_8[] = { 'a' };
static const symbol s_9[] = { 'e' };
static const symbol s_10[] = { 'a' };
static const symbol s_11[] = { 'e' };
static const symbol s_12[] = { 'a' };
static const symbol s_13[] = { 'e' };

static const symbol s_0_0[1] = { 0xE1 };
static const symbol s_0_1[1] = { 0xE9 };
static const struct among a_0[2] = {
{ 1, s_0_0, 0, 1, 0},
{ 1, s_0_1, 0, 2, 0}
};

static const symbol s_1_0[2] = { 'b', 'b' };
static const symbol s_1_1[2] = { 'c', 'c' };
static const symbol s_1_2[2] = { 'd', 'd' };
static const symbol s_1_3[2] = { 'f', 'f' };
static const symbol s_1_4[2] = { 'g', 'g' };
static const symbol s_1_5[2] = { 'j', 'j' };
static const symbol s_1_6[2] = { 'k', 'k' };
static const symbol s_1_7[2] = { 'l', 'l' };
static const symbol s_1_8[2] = { 'm', 'm' };
static const symbol s_1_9[2] = { 'n', 'n' };
static const symbol s_1_10[2] = { 'p', 'p' };
static const symbol s_1_11[2] = { 'r', 'r' };
static const symbol s_1_12[3] = { 'c', 'c', 's' };
static const symbol s_1_13[2] = { 's', 's' };
static const symbol s_1_14[3] = { 'z', 'z', 's' };
static const symbol s_1_15[2] = { 't', 't' };
static const symbol s_1_16[2] = { 'v', 'v' };
static const symbol s_1_17[3] = { 'g', 'g', 'y' };
static const symbol s_1_18[3] = { 'l', 'l', 'y' };
static const symbol s_1_19[3] = { 'n', 'n', 'y' };
static const symbol s_1_20[3] = { 't', 't', 'y' };
static const symbol s_1_21[3] = { 's', 's', 'z' };
static const symbol s_1_22[2] = { 'z', 'z' };
static const struct among a_1[23] = {
{ 2, s_1_0, 0, -1, 0},
{ 2, s_1_1, 0, -1, 0},
{ 2, s_1_2, 0, -1, 0},
{ 2, s_1_3, 0, -1, 0},
{ 2, s_1_4, 0, -1, 0},
{ 2, s_1_5, 0, -1, 0},
{ 2, s_1_6, 0, -1, 0},
{ 2, s_1_7, 0, -1, 0},
{ 2, s_1_8, 0, -1, 0},
{ 2, s_1_9, 0, -1, 0},
{ 2, s_1_10, 0, -1, 0},
{ 2, s_1_11, 0, -1, 0},
{ 3, s_1_12, 0, -1, 0},
{ 2, s_1_13, 0, -1, 0},
{ 3, s_1_14, 0, -1, 0},
{ 2, s_1_15, 0, -1, 0},
{ 2, s_1_16, 0, -1, 0},
{ 3, s_1_17, 0, -1, 0},
{ 3, s_1_18, 0, -1, 0},
{ 3, s_1_19, 0, -1, 0},
{ 3, s_1_20, 0, -1, 0},
{ 3, s_1_21, 0, -1, 0},
{ 2, s_1_22, 0, -1, 0}
};

static const symbol s_2_0[2] = { 'a', 'l' };
static const symbol s_2_1[2] = { 'e', 'l' };
static const struct among a_2[2] = {
{ 2, s_2_0, 0, 1, 0},
{ 2, s_2_1, 0, 1, 0}
};

static const symbol s_3_0[2] = { 'b', 'a' };
static const symbol s_3_1[2] = { 'r', 'a' };
static const symbol s_3_2[2] = { 'b', 'e' };
static const symbol s_3_3[2] = { 'r', 'e' };
static const symbol s_3_4[2] = { 'i', 'g' };
static const symbol s_3_5[3] = { 'n', 'a', 'k' };
static const symbol s_3_6[3] = { 'n', 'e', 'k' };
static const symbol s_3_7[3] = { 'v', 'a', 'l' };
static const symbol s_3_8[3] = { 'v', 'e', 'l' };
static const symbol s_3_9[2] = { 'u', 'l' };
static const symbol s_3_10[3] = { 'n', 0xE1, 'l' };
static const symbol s_3_11[3] = { 'n', 0xE9, 'l' };
static const symbol s_3_12[3] = { 'b', 0xF3, 'l' };
static const symbol s_3_13[3] = { 'r', 0xF3, 'l' };
static const symbol s_3_14[3] = { 't', 0xF3, 'l' };
static const symbol s_3_15[2] = { 0xFC, 'l' };
static const symbol s_3_16[3] = { 'b', 0x151, 'l' };
static const symbol s_3_17[3] = { 'r', 0x151, 'l' };
static const symbol s_3_18[3] = { 't', 0x151, 'l' };
static const symbol s_3_19[1] = { 'n' };
static const symbol s_3_20[2] = { 'a', 'n' };
static const symbol s_3_21[3] = { 'b', 'a', 'n' };
static const symbol s_3_22[2] = { 'e', 'n' };
static const symbol s_3_23[3] = { 'b', 'e', 'n' };
static const symbol s_3_24[6] = { 'k', 0xE9, 'p', 'p', 'e', 'n' };
static const symbol s_3_25[2] = { 'o', 'n' };
static const symbol s_3_26[2] = { 0xF6, 'n' };
static const symbol s_3_27[4] = { 'k', 0xE9, 'p', 'p' };
static const symbol s_3_28[3] = { 'k', 'o', 'r' };
static const symbol s_3_29[1] = { 't' };
static const symbol s_3_30[2] = { 'a', 't' };
static const symbol s_3_31[2] = { 'e', 't' };
static const symbol s_3_32[4] = { 'k', 0xE9, 'n', 't' };
static const symbol s_3_33[6] = { 'a', 'n', 'k', 0xE9, 'n', 't' };
static const symbol s_3_34[6] = { 'e', 'n', 'k', 0xE9, 'n', 't' };
static const symbol s_3_35[6] = { 'o', 'n', 'k', 0xE9, 'n', 't' };
static const symbol s_3_36[2] = { 'o', 't' };
static const symbol s_3_37[3] = { 0xE9, 'r', 't' };
static const symbol s_3_38[2] = { 0xF6, 't' };
static const symbol s_3_39[3] = { 'h', 'e', 'z' };
static const symbol s_3_40[3] = { 'h', 'o', 'z' };
static const symbol s_3_41[3] = { 'h', 0xF6, 'z' };
static const symbol s_3_42[2] = { 'v', 0xE1 };
static const symbol s_3_43[2] = { 'v', 0xE9 };
static const struct among a_3[44] = {
{ 2, s_3_0, 0, -1, 0},
{ 2, s_3_1, 0, -1, 0},
{ 2, s_3_2, 0, -1, 0},
{ 2, s_3_3, 0, -1, 0},
{ 2, s_3_4, 0, -1, 0},
{ 3, s_3_5, 0, -1, 0},
{ 3, s_3_6, 0, -1, 0},
{ 3, s_3_7, 0, -1, 0},
{ 3, s_3_8, 0, -1, 0},
{ 2, s_3_9, 0, -1, 0},
{ 3, s_3_10, 0, -1, 0},
{ 3, s_3_11, 0, -1, 0},
{ 3, s_3_12, 0, -1, 0},
{ 3, s_3_13, 0, -1, 0},
{ 3, s_3_14, 0, -1, 0},
{ 2, s_3_15, 0, -1, 0},
{ 3, s_3_16, 0, -1, 0},
{ 3, s_3_17, 0, -1, 0},
{ 3, s_3_18, 0, -1, 0},
{ 1, s_3_19, 0, -1, 0},
{ 2, s_3_20, -1, -1, 0},
{ 3, s_3_21, -1, -1, 0},
{ 2, s_3_22, -3, -1, 0},
{ 3, s_3_23, -1, -1, 0},
{ 6, s_3_24, -2, -1, 0},
{ 2, s_3_25, -6, -1, 0},
{ 2, s_3_26, -7, -1, 0},
{ 4, s_3_27, 0, -1, 0},
{ 3, s_3_28, 0, -1, 0},
{ 1, s_3_29, 0, -1, 0},
{ 2, s_3_30, -1, -1, 0},
{ 2, s_3_31, -2, -1, 0},
{ 4, s_3_32, -3, -1, 0},
{ 6, s_3_33, -1, -1, 0},
{ 6, s_3_34, -2, -1, 0},
{ 6, s_3_35, -3, -1, 0},
{ 2, s_3_36, -7, -1, 0},
{ 3, s_3_37, -8, -1, 0},
{ 2, s_3_38, -9, -1, 0},
{ 3, s_3_39, 0, -1, 0},
{ 3, s_3_40, 0, -1, 0},
{ 3, s_3_41, 0, -1, 0},
{ 2, s_3_42, 0, -1, 0},
{ 2, s_3_43, 0, -1, 0}
};

static const symbol s_4_0[2] = { 0xE1, 'n' };
static const symbol s_4_1[2] = { 0xE9, 'n' };
static const symbol s_4_2[6] = { 0xE1, 'n', 'k', 0xE9, 'n', 't' };
static const struct among a_4[3] = {
{ 2, s_4_0, 0, 2, 0},
{ 2, s_4_1, 0, 1, 0},
{ 6, s_4_2, 0, 2, 0}
};

static const symbol s_5_0[4] = { 's', 't', 'u', 'l' };
static const symbol s_5_1[5] = { 'a', 's', 't', 'u', 'l' };
static const symbol s_5_2[5] = { 0xE1, 's', 't', 'u', 'l' };
static const symbol s_5_3[4] = { 's', 't', 0xFC, 'l' };
static const symbol s_5_4[5] = { 'e', 's', 't', 0xFC, 'l' };
static const symbol s_5_5[5] = { 0xE9, 's', 't', 0xFC, 'l' };
static const struct among a_5[6] = {
{ 4, s_5_0, 0, 1, 0},
{ 5, s_5_1, -1, 1, 0},
{ 5, s_5_2, -2, 2, 0},
{ 4, s_5_3, 0, 1, 0},
{ 5, s_5_4, -1, 1, 0},
{ 5, s_5_5, -2, 3, 0}
};

static const symbol s_7_0[1] = { 'k' };
static const symbol s_7_1[2] = { 'a', 'k' };
static const symbol s_7_2[2] = { 'e', 'k' };
static const symbol s_7_3[2] = { 'o', 'k' };
static const symbol s_7_4[2] = { 0xE1, 'k' };
static const symbol s_7_5[2] = { 0xE9, 'k' };
static const symbol s_7_6[2] = { 0xF6, 'k' };
static const struct among a_7[7] = {
{ 1, s_7_0, 0, 3, 0},
{ 2, s_7_1, -1, 3, 0},
{ 2, s_7_2, -2, 3, 0},
{ 2, s_7_3, -3, 3, 0},
{ 2, s_7_4, -4, 1, 0},
{ 2, s_7_5, -5, 2, 0},
{ 2, s_7_6, -6, 3, 0}
};

static const symbol s_8_0[2] = { 0xE9, 'i' };
static const symbol s_8_1[3] = { 0xE1, 0xE9, 'i' };
static const symbol s_8_2[3] = { 0xE9, 0xE9, 'i' };
static const symbol s_8_3[1] = { 0xE9 };
static const symbol s_8_4[2] = { 'k', 0xE9 };
static const symbol s_8_5[3] = { 'a', 'k', 0xE9 };
static const symbol s_8_6[3] = { 'e', 'k', 0xE9 };
static const symbol s_8_7[3] = { 'o', 'k', 0xE9 };
static const symbol s_8_8[3] = { 0xE1, 'k', 0xE9 };
static const symbol s_8_9[3] = { 0xE9, 'k', 0xE9 };
static const symbol s_8_10[3] = { 0xF6, 'k', 0xE9 };
static const symbol s_8_11[2] = { 0xE9, 0xE9 };
static const struct among a_8[12] = {
{ 2, s_8_0, 0, 1, 0},
{ 3, s_8_1, -1, 3, 0},
{ 3, s_8_2, -2, 2, 0},
{ 1, s_8_3, 0, 1, 0},
{ 2, s_8_4, -1, 1, 0},
{ 3, s_8_5, -1, 1, 0},
{ 3, s_8_6, -2, 1, 0},
{ 3, s_8_7, -3, 1, 0},
{ 3, s_8_8, -4, 3, 0},
{ 3, s_8_9, -5, 2, 0},
{ 3, s_8_10, -6, 1, 0},
{ 2, s_8_11, -8, 2, 0}
};

static const symbol s_9_0[1] = { 'a' };
static const symbol s_9_1[2] = { 'j', 'a' };
static const symbol s_9_2[1] = { 'd' };
static const symbol s_9_3[2] = { 'a', 'd' };
static const symbol s_9_4[2] = { 'e', 'd' };
static const symbol s_9_5[2] = { 'o', 'd' };
static const symbol s_9_6[2] = { 0xE1, 'd' };
static const symbol s_9_7[2] = { 0xE9, 'd' };
static const symbol s_9_8[2] = { 0xF6, 'd' };
static const symbol s_9_9[1] = { 'e' };
static const symbol s_9_10[2] = { 'j', 'e' };
static const symbol s_9_11[2] = { 'n', 'k' };
static const symbol s_9_12[3] = { 'u', 'n', 'k' };
static const symbol s_9_13[3] = { 0xE1, 'n', 'k' };
static const symbol s_9_14[3] = { 0xE9, 'n', 'k' };
static const symbol s_9_15[3] = { 0xFC, 'n', 'k' };
static const symbol s_9_16[2] = { 'u', 'k' };
static const symbol s_9_17[3] = { 'j', 'u', 'k' };
static const symbol s_9_18[4] = { 0xE1, 'j', 'u', 'k' };
static const symbol s_9_19[2] = { 0xFC, 'k' };
static const symbol s_9_20[3] = { 'j', 0xFC, 'k' };
static const symbol s_9_21[4] = { 0xE9, 'j', 0xFC, 'k' };
static const symbol s_9_22[1] = { 'm' };
static const symbol s_9_23[2] = { 'a', 'm' };
static const symbol s_9_24[2] = { 'e', 'm' };
static const symbol s_9_25[2] = { 'o', 'm' };
static const symbol s_9_26[2] = { 0xE1, 'm' };
static const symbol s_9_27[2] = { 0xE9, 'm' };
static const symbol s_9_28[1] = { 'o' };
static const symbol s_9_29[1] = { 0xE1 };
static const symbol s_9_30[1] = { 0xE9 };
static const struct among a_9[31] = {
{ 1, s_9_0, 0, 1, 0},
{ 2, s_9_1, -1, 1, 0},
{ 1, s_9_2, 0, 1, 0},
{ 2, s_9_3, -1, 1, 0},
{ 2, s_9_4, -2, 1, 0},
{ 2, s_9_5, -3, 1, 0},
{ 2, s_9_6, -4, 2, 0},
{ 2, s_9_7, -5, 3, 0},
{ 2, s_9_8, -6, 1, 0},
{ 1, s_9_9, 0, 1, 0},
{ 2, s_9_10, -1, 1, 0},
{ 2, s_9_11, 0, 1, 0},
{ 3, s_9_12, -1, 1, 0},
{ 3, s_9_13, -2, 2, 0},
{ 3, s_9_14, -3, 3, 0},
{ 3, s_9_15, -4, 1, 0},
{ 2, s_9_16, 0, 1, 0},
{ 3, s_9_17, -1, 1, 0},
{ 4, s_9_18, -1, 2, 0},
{ 2, s_9_19, 0, 1, 0},
{ 3, s_9_20, -1, 1, 0},
{ 4, s_9_21, -1, 3, 0},
{ 1, s_9_22, 0, 1, 0},
{ 2, s_9_23, -1, 1, 0},
{ 2, s_9_24, -2, 1, 0},
{ 2, s_9_25, -3, 1, 0},
{ 2, s_9_26, -4, 2, 0},
{ 2, s_9_27, -5, 3, 0},
{ 1, s_9_28, 0, 1, 0},
{ 1, s_9_29, 0, 2, 0},
{ 1, s_9_30, 0, 3, 0}
};

static const symbol s_10_0[2] = { 'i', 'd' };
static const symbol s_10_1[3] = { 'a', 'i', 'd' };
static const symbol s_10_2[4] = { 'j', 'a', 'i', 'd' };
static const symbol s_10_3[3] = { 'e', 'i', 'd' };
static const symbol s_10_4[4] = { 'j', 'e', 'i', 'd' };
static const symbol s_10_5[3] = { 0xE1, 'i', 'd' };
static const symbol s_10_6[3] = { 0xE9, 'i', 'd' };
static const symbol s_10_7[1] = { 'i' };
static const symbol s_10_8[2] = { 'a', 'i' };
static const symbol s_10_9[3] = { 'j', 'a', 'i' };
static const symbol s_10_10[2] = { 'e', 'i' };
static const symbol s_10_11[3] = { 'j', 'e', 'i' };
static const symbol s_10_12[2] = { 0xE1, 'i' };
static const symbol s_10_13[2] = { 0xE9, 'i' };
static const symbol s_10_14[4] = { 'i', 't', 'e', 'k' };
static const symbol s_10_15[5] = { 'e', 'i', 't', 'e', 'k' };
static const symbol s_10_16[6] = { 'j', 'e', 'i', 't', 'e', 'k' };
static const symbol s_10_17[5] = { 0xE9, 'i', 't', 'e', 'k' };
static const symbol s_10_18[2] = { 'i', 'k' };
static const symbol s_10_19[3] = { 'a', 'i', 'k' };
static const symbol s_10_20[4] = { 'j', 'a', 'i', 'k' };
static const symbol s_10_21[3] = { 'e', 'i', 'k' };
static const symbol s_10_22[4] = { 'j', 'e', 'i', 'k' };
static const symbol s_10_23[3] = { 0xE1, 'i', 'k' };
static const symbol s_10_24[3] = { 0xE9, 'i', 'k' };
static const symbol s_10_25[3] = { 'i', 'n', 'k' };
static const symbol s_10_26[4] = { 'a', 'i', 'n', 'k' };
static const symbol s_10_27[5] = { 'j', 'a', 'i', 'n', 'k' };
static const symbol s_10_28[4] = { 'e', 'i', 'n', 'k' };
static const symbol s_10_29[5] = { 'j', 'e', 'i', 'n', 'k' };
static const symbol s_10_30[4] = { 0xE1, 'i', 'n', 'k' };
static const symbol s_10_31[4] = { 0xE9, 'i', 'n', 'k' };
static const symbol s_10_32[5] = { 'a', 'i', 't', 'o', 'k' };
static const symbol s_10_33[6] = { 'j', 'a', 'i', 't', 'o', 'k' };
static const symbol s_10_34[5] = { 0xE1, 'i', 't', 'o', 'k' };
static const symbol s_10_35[2] = { 'i', 'm' };
static const symbol s_10_36[3] = { 'a', 'i', 'm' };
static const symbol s_10_37[4] = { 'j', 'a', 'i', 'm' };
static const symbol s_10_38[3] = { 'e', 'i', 'm' };
static const symbol s_10_39[4] = { 'j', 'e', 'i', 'm' };
static const symbol s_10_40[3] = { 0xE1, 'i', 'm' };
static const symbol s_10_41[3] = { 0xE9, 'i', 'm' };
static const struct among a_10[42] = {
{ 2, s_10_0, 0, 1, 0},
{ 3, s_10_1, -1, 1, 0},
{ 4, s_10_2, -1, 1, 0},
{ 3, s_10_3, -3, 1, 0},
{ 4, s_10_4, -1, 1, 0},
{ 3, s_10_5, -5, 2, 0},
{ 3, s_10_6, -6, 3, 0},
{ 1, s_10_7, 0, 1, 0},
{ 2, s_10_8, -1, 1, 0},
{ 3, s_10_9, -1, 1, 0},
{ 2, s_10_10, -3, 1, 0},
{ 3, s_10_11, -1, 1, 0},
{ 2, s_10_12, -5, 2, 0},
{ 2, s_10_13, -6, 3, 0},
{ 4, s_10_14, 0, 1, 0},
{ 5, s_10_15, -1, 1, 0},
{ 6, s_10_16, -1, 1, 0},
{ 5, s_10_17, -3, 3, 0},
{ 2, s_10_18, 0, 1, 0},
{ 3, s_10_19, -1, 1, 0},
{ 4, s_10_20, -1, 1, 0},
{ 3, s_10_21, -3, 1, 0},
{ 4, s_10_22, -1, 1, 0},
{ 3, s_10_23, -5, 2, 0},
{ 3, s_10_24, -6, 3, 0},
{ 3, s_10_25, 0, 1, 0},
{ 4, s_10_26, -1, 1, 0},
{ 5, s_10_27, -1, 1, 0},
{ 4, s_10_28, -3, 1, 0},
{ 5, s_10_29, -1, 1, 0},
{ 4, s_10_30, -5, 2, 0},
{ 4, s_10_31, -6, 3, 0},
{ 5, s_10_32, 0, 1, 0},
{ 6, s_10_33, -1, 1, 0},
{ 5, s_10_34, 0, 2, 0},
{ 2, s_10_35, 0, 1, 0},
{ 3, s_10_36, -1, 1, 0},
{ 4, s_10_37, -1, 1, 0},
{ 3, s_10_38, -3, 1, 0},
{ 4, s_10_39, -1, 1, 0},
{ 3, s_10_40, -5, 2, 0},
{ 3, s_10_41, -6, 3, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 36, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1 };

static int r_double(struct SN_env * z) {
    {
        int v_1 = z->l - z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((106790108 >> (z->p[z->c - 1] & 0x1f)) & 1)) return 0;
        if (!find_among_b(z, a_1, 23, 0)) return 0;
        z->c = z->l - v_1;
    }
    return 1;
}

static int r_undouble(struct SN_env * z) {
    if (z->c <= z->lb) return 0;
    z->c--;
    z->ket = z->c;
    if (z->c <= z->lb) return 0;
    z->c--;
    z->bra = z->c;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    return 1;
}

extern int hungarian_stem(struct SN_env * z) {
    int among_var;
    int i_p1;
    {
        int v_1 = z->c;
        i_p1 = z->l;
        do {
            int v_2 = z->c;
            if (in_grouping(z, g_v, 97, 369, 0)) goto lab1;
            {
                int v_3 = z->c;
                {
                    int ret = in_grouping(z, g_v, 97, 369, 1);
                    if (ret < 0) goto lab2;
                    z->c += ret;
                }
                i_p1 = z->c;
            lab2:
                z->c = v_3;
            }
            break;
        lab1:
            z->c = v_2;
            {
                int ret = out_grouping(z, g_v, 97, 369, 1);
                if (ret < 0) goto lab0;
                z->c += ret;
            }
            i_p1 = z->c;
        } while (0);
    lab0:
        z->c = v_1;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_4 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] != 108) goto lab3;
        if (!find_among_b(z, a_2, 2, 0)) goto lab3;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab3;
        if (!r_double(z)) goto lab3;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        {
            int ret = r_undouble(z);
            if (ret == 0) goto lab3;
            if (ret < 0) return ret;
        }
    lab3:
        z->c = z->l - v_4;
    }
    {
        int v_5 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_3, 44, 0)) goto lab4;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab4;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        z->ket = z->c;
        if (z->c <= z->lb || (z->p[z->c - 1] != 225 && z->p[z->c - 1] != 233)) goto lab4;
        among_var = find_among_b(z, a_0, 2, 0);
        if (!among_var) goto lab4;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab4;
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
        }
    lab4:
        z->c = z->l - v_5;
    }
    {
        int v_6 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 110 && z->p[z->c - 1] != 116)) goto lab5;
        among_var = find_among_b(z, a_4, 3, 0);
        if (!among_var) goto lab5;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab5;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_2);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_3);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab5:
        z->c = z->l - v_6;
    }
    {
        int v_7 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 3 <= z->lb || z->p[z->c - 1] != 108) goto lab6;
        among_var = find_among_b(z, a_5, 6, 0);
        if (!among_var) goto lab6;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab6;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_4);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_5);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab6:
        z->c = z->l - v_7;
    }
    {
        int v_8 = z->l - z->c;
        z->ket = z->c;
        if (z->c <= z->lb || (z->p[z->c - 1] != 225 && z->p[z->c - 1] != 233)) goto lab7;
        z->c--;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab7;
        if (!r_double(z)) goto lab7;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        {
            int ret = r_undouble(z);
            if (ret == 0) goto lab7;
            if (ret < 0) return ret;
        }
    lab7:
        z->c = z->l - v_8;
    }
    {
        int v_9 = z->l - z->c;
        z->ket = z->c;
        if (z->c <= z->lb || (z->p[z->c - 1] != 105 && z->p[z->c - 1] != 233)) goto lab8;
        among_var = find_among_b(z, a_8, 12, 0);
        if (!among_var) goto lab8;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab8;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_6);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_7);
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
        among_var = find_among_b(z, a_9, 31, 0);
        if (!among_var) goto lab9;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab9;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_8);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_9);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab9:
        z->c = z->l - v_10;
    }
    {
        int v_11 = z->l - z->c;
        z->ket = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((10768 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab10;
        among_var = find_among_b(z, a_10, 42, 0);
        if (!among_var) goto lab10;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab10;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_10);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_11);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab10:
        z->c = z->l - v_11;
    }
    {
        int v_12 = z->l - z->c;
        z->ket = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] != 107) goto lab11;
        among_var = find_among_b(z, a_7, 7, 0);
        if (!among_var) goto lab11;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab11;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_12);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_13);
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
    lab11:
        z->c = z->l - v_12;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * hungarian_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
