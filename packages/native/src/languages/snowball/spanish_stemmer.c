/*
 * Generated from algorithms/spanish.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "spanish_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int spanish_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 'i', 'e', 'n', 'd', 'o' };
static const symbol s_1[] = { 'a', 'n', 'd', 'o' };
static const symbol s_2[] = { 'a', 'r' };
static const symbol s_3[] = { 'e', 'r' };
static const symbol s_4[] = { 'i', 'r' };
static const symbol s_5[] = { 'i', 'c' };
static const symbol s_6[] = { 'l', 'o', 'g' };
static const symbol s_7[] = { 'u' };
static const symbol s_8[] = { 'e', 'n', 't', 'e' };
static const symbol s_9[] = { 'a', 't' };
static const symbol s_10[] = { 'a', 't' };
static const symbol s_11[] = { 'a' };
static const symbol s_12[] = { 'e' };
static const symbol s_13[] = { 'i' };
static const symbol s_14[] = { 'o' };
static const symbol s_15[] = { 'u' };

static const symbol s_0_1[1] = { 0xE1 };
static const symbol s_0_2[1] = { 0xE9 };
static const symbol s_0_3[1] = { 0xED };
static const symbol s_0_4[1] = { 0xF3 };
static const symbol s_0_5[1] = { 0xFA };
static const struct among a_0[6] = {
{ 0, 0, 0, 6, 0},
{ 1, s_0_1, -1, 1, 0},
{ 1, s_0_2, -2, 2, 0},
{ 1, s_0_3, -3, 3, 0},
{ 1, s_0_4, -4, 4, 0},
{ 1, s_0_5, -5, 5, 0}
};

static const symbol s_1_0[2] = { 'l', 'a' };
static const symbol s_1_1[4] = { 's', 'e', 'l', 'a' };
static const symbol s_1_2[2] = { 'l', 'e' };
static const symbol s_1_3[2] = { 'm', 'e' };
static const symbol s_1_4[2] = { 's', 'e' };
static const symbol s_1_5[2] = { 'l', 'o' };
static const symbol s_1_6[4] = { 's', 'e', 'l', 'o' };
static const symbol s_1_7[3] = { 'l', 'a', 's' };
static const symbol s_1_8[5] = { 's', 'e', 'l', 'a', 's' };
static const symbol s_1_9[3] = { 'l', 'e', 's' };
static const symbol s_1_10[3] = { 'l', 'o', 's' };
static const symbol s_1_11[5] = { 's', 'e', 'l', 'o', 's' };
static const symbol s_1_12[3] = { 'n', 'o', 's' };
static const struct among a_1[13] = {
{ 2, s_1_0, 0, -1, 0},
{ 4, s_1_1, -1, -1, 0},
{ 2, s_1_2, 0, -1, 0},
{ 2, s_1_3, 0, -1, 0},
{ 2, s_1_4, 0, -1, 0},
{ 2, s_1_5, 0, -1, 0},
{ 4, s_1_6, -1, -1, 0},
{ 3, s_1_7, 0, -1, 0},
{ 5, s_1_8, -1, -1, 0},
{ 3, s_1_9, 0, -1, 0},
{ 3, s_1_10, 0, -1, 0},
{ 5, s_1_11, -1, -1, 0},
{ 3, s_1_12, 0, -1, 0}
};

static const symbol s_2_0[4] = { 'a', 'n', 'd', 'o' };
static const symbol s_2_1[5] = { 'i', 'e', 'n', 'd', 'o' };
static const symbol s_2_2[5] = { 'y', 'e', 'n', 'd', 'o' };
static const symbol s_2_3[4] = { 0xE1, 'n', 'd', 'o' };
static const symbol s_2_4[5] = { 'i', 0xE9, 'n', 'd', 'o' };
static const symbol s_2_5[2] = { 'a', 'r' };
static const symbol s_2_6[2] = { 'e', 'r' };
static const symbol s_2_7[2] = { 'i', 'r' };
static const symbol s_2_8[2] = { 0xE1, 'r' };
static const symbol s_2_9[2] = { 0xE9, 'r' };
static const symbol s_2_10[2] = { 0xED, 'r' };
static const struct among a_2[11] = {
{ 4, s_2_0, 0, 6, 0},
{ 5, s_2_1, 0, 6, 0},
{ 5, s_2_2, 0, 7, 0},
{ 4, s_2_3, 0, 2, 0},
{ 5, s_2_4, 0, 1, 0},
{ 2, s_2_5, 0, 6, 0},
{ 2, s_2_6, 0, 6, 0},
{ 2, s_2_7, 0, 6, 0},
{ 2, s_2_8, 0, 3, 0},
{ 2, s_2_9, 0, 4, 0},
{ 2, s_2_10, 0, 5, 0}
};

static const symbol s_3_0[2] = { 'i', 'c' };
static const symbol s_3_1[2] = { 'a', 'd' };
static const symbol s_3_2[2] = { 'o', 's' };
static const symbol s_3_3[2] = { 'i', 'v' };
static const struct among a_3[4] = {
{ 2, s_3_0, 0, -1, 0},
{ 2, s_3_1, 0, -1, 0},
{ 2, s_3_2, 0, -1, 0},
{ 2, s_3_3, 0, 1, 0}
};

static const symbol s_4_0[4] = { 'a', 'b', 'l', 'e' };
static const symbol s_4_1[4] = { 'i', 'b', 'l', 'e' };
static const symbol s_4_2[4] = { 'a', 'n', 't', 'e' };
static const struct among a_4[3] = {
{ 4, s_4_0, 0, 1, 0},
{ 4, s_4_1, 0, 1, 0},
{ 4, s_4_2, 0, 1, 0}
};

static const symbol s_5_0[2] = { 'i', 'c' };
static const symbol s_5_1[4] = { 'a', 'b', 'i', 'l' };
static const symbol s_5_2[2] = { 'i', 'v' };
static const struct among a_5[3] = {
{ 2, s_5_0, 0, 1, 0},
{ 4, s_5_1, 0, 1, 0},
{ 2, s_5_2, 0, 1, 0}
};

static const symbol s_6_0[3] = { 'i', 'c', 'a' };
static const symbol s_6_1[5] = { 'a', 'n', 'c', 'i', 'a' };
static const symbol s_6_2[5] = { 'e', 'n', 'c', 'i', 'a' };
static const symbol s_6_3[5] = { 'a', 'd', 'o', 'r', 'a' };
static const symbol s_6_4[3] = { 'o', 's', 'a' };
static const symbol s_6_5[4] = { 'i', 's', 't', 'a' };
static const symbol s_6_6[3] = { 'i', 'v', 'a' };
static const symbol s_6_7[4] = { 'a', 'n', 'z', 'a' };
static const symbol s_6_8[5] = { 'l', 'o', 'g', 0xED, 'a' };
static const symbol s_6_9[4] = { 'i', 'd', 'a', 'd' };
static const symbol s_6_10[4] = { 'a', 'b', 'l', 'e' };
static const symbol s_6_11[4] = { 'i', 'b', 'l', 'e' };
static const symbol s_6_12[4] = { 'a', 'n', 't', 'e' };
static const symbol s_6_13[5] = { 'm', 'e', 'n', 't', 'e' };
static const symbol s_6_14[6] = { 'a', 'm', 'e', 'n', 't', 'e' };
static const symbol s_6_15[5] = { 'a', 'c', 'i', 'o', 'n' };
static const symbol s_6_16[5] = { 'u', 'c', 'i', 'o', 'n' };
static const symbol s_6_17[5] = { 'a', 'c', 'i', 0xF3, 'n' };
static const symbol s_6_18[5] = { 'u', 'c', 'i', 0xF3, 'n' };
static const symbol s_6_19[3] = { 'i', 'c', 'o' };
static const symbol s_6_20[4] = { 'i', 's', 'm', 'o' };
static const symbol s_6_21[3] = { 'o', 's', 'o' };
static const symbol s_6_22[7] = { 'a', 'm', 'i', 'e', 'n', 't', 'o' };
static const symbol s_6_23[7] = { 'i', 'm', 'i', 'e', 'n', 't', 'o' };
static const symbol s_6_24[3] = { 'i', 'v', 'o' };
static const symbol s_6_25[4] = { 'a', 'd', 'o', 'r' };
static const symbol s_6_26[4] = { 'i', 'c', 'a', 's' };
static const symbol s_6_27[6] = { 'a', 'n', 'c', 'i', 'a', 's' };
static const symbol s_6_28[6] = { 'e', 'n', 'c', 'i', 'a', 's' };
static const symbol s_6_29[6] = { 'a', 'd', 'o', 'r', 'a', 's' };
static const symbol s_6_30[4] = { 'o', 's', 'a', 's' };
static const symbol s_6_31[5] = { 'i', 's', 't', 'a', 's' };
static const symbol s_6_32[4] = { 'i', 'v', 'a', 's' };
static const symbol s_6_33[5] = { 'a', 'n', 'z', 'a', 's' };
static const symbol s_6_34[6] = { 'l', 'o', 'g', 0xED, 'a', 's' };
static const symbol s_6_35[6] = { 'i', 'd', 'a', 'd', 'e', 's' };
static const symbol s_6_36[5] = { 'a', 'b', 'l', 'e', 's' };
static const symbol s_6_37[5] = { 'i', 'b', 'l', 'e', 's' };
static const symbol s_6_38[7] = { 'a', 'c', 'i', 'o', 'n', 'e', 's' };
static const symbol s_6_39[7] = { 'u', 'c', 'i', 'o', 'n', 'e', 's' };
static const symbol s_6_40[6] = { 'a', 'd', 'o', 'r', 'e', 's' };
static const symbol s_6_41[5] = { 'a', 'n', 't', 'e', 's' };
static const symbol s_6_42[4] = { 'i', 'c', 'o', 's' };
static const symbol s_6_43[5] = { 'i', 's', 'm', 'o', 's' };
static const symbol s_6_44[4] = { 'o', 's', 'o', 's' };
static const symbol s_6_45[8] = { 'a', 'm', 'i', 'e', 'n', 't', 'o', 's' };
static const symbol s_6_46[8] = { 'i', 'm', 'i', 'e', 'n', 't', 'o', 's' };
static const symbol s_6_47[4] = { 'i', 'v', 'o', 's' };
static const struct among a_6[48] = {
{ 3, s_6_0, 0, 1, 0},
{ 5, s_6_1, 0, 2, 0},
{ 5, s_6_2, 0, 5, 0},
{ 5, s_6_3, 0, 2, 0},
{ 3, s_6_4, 0, 1, 0},
{ 4, s_6_5, 0, 1, 0},
{ 3, s_6_6, 0, 9, 0},
{ 4, s_6_7, 0, 1, 0},
{ 5, s_6_8, 0, 3, 0},
{ 4, s_6_9, 0, 8, 0},
{ 4, s_6_10, 0, 1, 0},
{ 4, s_6_11, 0, 1, 0},
{ 4, s_6_12, 0, 2, 0},
{ 5, s_6_13, 0, 7, 0},
{ 6, s_6_14, -1, 6, 0},
{ 5, s_6_15, 0, 2, 0},
{ 5, s_6_16, 0, 4, 0},
{ 5, s_6_17, 0, 2, 0},
{ 5, s_6_18, 0, 4, 0},
{ 3, s_6_19, 0, 1, 0},
{ 4, s_6_20, 0, 1, 0},
{ 3, s_6_21, 0, 1, 0},
{ 7, s_6_22, 0, 1, 0},
{ 7, s_6_23, 0, 1, 0},
{ 3, s_6_24, 0, 9, 0},
{ 4, s_6_25, 0, 2, 0},
{ 4, s_6_26, 0, 1, 0},
{ 6, s_6_27, 0, 2, 0},
{ 6, s_6_28, 0, 5, 0},
{ 6, s_6_29, 0, 2, 0},
{ 4, s_6_30, 0, 1, 0},
{ 5, s_6_31, 0, 1, 0},
{ 4, s_6_32, 0, 9, 0},
{ 5, s_6_33, 0, 1, 0},
{ 6, s_6_34, 0, 3, 0},
{ 6, s_6_35, 0, 8, 0},
{ 5, s_6_36, 0, 1, 0},
{ 5, s_6_37, 0, 1, 0},
{ 7, s_6_38, 0, 2, 0},
{ 7, s_6_39, 0, 4, 0},
{ 6, s_6_40, 0, 2, 0},
{ 5, s_6_41, 0, 2, 0},
{ 4, s_6_42, 0, 1, 0},
{ 5, s_6_43, 0, 1, 0},
{ 4, s_6_44, 0, 1, 0},
{ 8, s_6_45, 0, 1, 0},
{ 8, s_6_46, 0, 1, 0},
{ 4, s_6_47, 0, 9, 0}
};

static const symbol s_7_0[2] = { 'y', 'a' };
static const symbol s_7_1[2] = { 'y', 'e' };
static const symbol s_7_2[3] = { 'y', 'a', 'n' };
static const symbol s_7_3[3] = { 'y', 'e', 'n' };
static const symbol s_7_4[5] = { 'y', 'e', 'r', 'o', 'n' };
static const symbol s_7_5[5] = { 'y', 'e', 'n', 'd', 'o' };
static const symbol s_7_6[2] = { 'y', 'o' };
static const symbol s_7_7[3] = { 'y', 'a', 's' };
static const symbol s_7_8[3] = { 'y', 'e', 's' };
static const symbol s_7_9[4] = { 'y', 'a', 'i', 's' };
static const symbol s_7_10[5] = { 'y', 'a', 'm', 'o', 's' };
static const symbol s_7_11[2] = { 'y', 0xF3 };
static const struct among a_7[12] = {
{ 2, s_7_0, 0, 1, 0},
{ 2, s_7_1, 0, 1, 0},
{ 3, s_7_2, 0, 1, 0},
{ 3, s_7_3, 0, 1, 0},
{ 5, s_7_4, 0, 1, 0},
{ 5, s_7_5, 0, 1, 0},
{ 2, s_7_6, 0, 1, 0},
{ 3, s_7_7, 0, 1, 0},
{ 3, s_7_8, 0, 1, 0},
{ 4, s_7_9, 0, 1, 0},
{ 5, s_7_10, 0, 1, 0},
{ 2, s_7_11, 0, 1, 0}
};

static const symbol s_8_0[3] = { 'a', 'b', 'a' };
static const symbol s_8_1[3] = { 'a', 'd', 'a' };
static const symbol s_8_2[3] = { 'i', 'd', 'a' };
static const symbol s_8_3[3] = { 'a', 'r', 'a' };
static const symbol s_8_4[4] = { 'i', 'e', 'r', 'a' };
static const symbol s_8_5[2] = { 0xED, 'a' };
static const symbol s_8_6[4] = { 'a', 'r', 0xED, 'a' };
static const symbol s_8_7[4] = { 'e', 'r', 0xED, 'a' };
static const symbol s_8_8[4] = { 'i', 'r', 0xED, 'a' };
static const symbol s_8_9[2] = { 'a', 'd' };
static const symbol s_8_10[2] = { 'e', 'd' };
static const symbol s_8_11[2] = { 'i', 'd' };
static const symbol s_8_12[3] = { 'a', 's', 'e' };
static const symbol s_8_13[4] = { 'i', 'e', 's', 'e' };
static const symbol s_8_14[4] = { 'a', 's', 't', 'e' };
static const symbol s_8_15[4] = { 'i', 's', 't', 'e' };
static const symbol s_8_16[2] = { 'a', 'n' };
static const symbol s_8_17[4] = { 'a', 'b', 'a', 'n' };
static const symbol s_8_18[4] = { 'a', 'r', 'a', 'n' };
static const symbol s_8_19[5] = { 'i', 'e', 'r', 'a', 'n' };
static const symbol s_8_20[3] = { 0xED, 'a', 'n' };
static const symbol s_8_21[5] = { 'a', 'r', 0xED, 'a', 'n' };
static const symbol s_8_22[5] = { 'e', 'r', 0xED, 'a', 'n' };
static const symbol s_8_23[5] = { 'i', 'r', 0xED, 'a', 'n' };
static const symbol s_8_24[2] = { 'e', 'n' };
static const symbol s_8_25[4] = { 'a', 's', 'e', 'n' };
static const symbol s_8_26[5] = { 'i', 'e', 's', 'e', 'n' };
static const symbol s_8_27[4] = { 'a', 'r', 'o', 'n' };
static const symbol s_8_28[5] = { 'i', 'e', 'r', 'o', 'n' };
static const symbol s_8_29[4] = { 'a', 'r', 0xE1, 'n' };
static const symbol s_8_30[4] = { 'e', 'r', 0xE1, 'n' };
static const symbol s_8_31[4] = { 'i', 'r', 0xE1, 'n' };
static const symbol s_8_32[3] = { 'a', 'd', 'o' };
static const symbol s_8_33[3] = { 'i', 'd', 'o' };
static const symbol s_8_34[4] = { 'a', 'n', 'd', 'o' };
static const symbol s_8_35[5] = { 'i', 'e', 'n', 'd', 'o' };
static const symbol s_8_36[2] = { 'a', 'r' };
static const symbol s_8_37[2] = { 'e', 'r' };
static const symbol s_8_38[2] = { 'i', 'r' };
static const symbol s_8_39[2] = { 'a', 's' };
static const symbol s_8_40[4] = { 'a', 'b', 'a', 's' };
static const symbol s_8_41[4] = { 'a', 'd', 'a', 's' };
static const symbol s_8_42[4] = { 'i', 'd', 'a', 's' };
static const symbol s_8_43[4] = { 'a', 'r', 'a', 's' };
static const symbol s_8_44[5] = { 'i', 'e', 'r', 'a', 's' };
static const symbol s_8_45[3] = { 0xED, 'a', 's' };
static const symbol s_8_46[5] = { 'a', 'r', 0xED, 'a', 's' };
static const symbol s_8_47[5] = { 'e', 'r', 0xED, 'a', 's' };
static const symbol s_8_48[5] = { 'i', 'r', 0xED, 'a', 's' };
static const symbol s_8_49[2] = { 'e', 's' };
static const symbol s_8_50[4] = { 'a', 's', 'e', 's' };
static const symbol s_8_51[5] = { 'i', 'e', 's', 'e', 's' };
static const symbol s_8_52[5] = { 'a', 'b', 'a', 'i', 's' };
static const symbol s_8_53[5] = { 'a', 'r', 'a', 'i', 's' };
static const symbol s_8_54[6] = { 'i', 'e', 'r', 'a', 'i', 's' };
static const symbol s_8_55[4] = { 0xED, 'a', 'i', 's' };
static const symbol s_8_56[6] = { 'a', 'r', 0xED, 'a', 'i', 's' };
static const symbol s_8_57[6] = { 'e', 'r', 0xED, 'a', 'i', 's' };
static const symbol s_8_58[6] = { 'i', 'r', 0xED, 'a', 'i', 's' };
static const symbol s_8_59[5] = { 'a', 's', 'e', 'i', 's' };
static const symbol s_8_60[6] = { 'i', 'e', 's', 'e', 'i', 's' };
static const symbol s_8_61[6] = { 'a', 's', 't', 'e', 'i', 's' };
static const symbol s_8_62[6] = { 'i', 's', 't', 'e', 'i', 's' };
static const symbol s_8_63[3] = { 0xE1, 'i', 's' };
static const symbol s_8_64[3] = { 0xE9, 'i', 's' };
static const symbol s_8_65[5] = { 'a', 'r', 0xE9, 'i', 's' };
static const symbol s_8_66[5] = { 'e', 'r', 0xE9, 'i', 's' };
static const symbol s_8_67[5] = { 'i', 'r', 0xE9, 'i', 's' };
static const symbol s_8_68[4] = { 'a', 'd', 'o', 's' };
static const symbol s_8_69[4] = { 'i', 'd', 'o', 's' };
static const symbol s_8_70[4] = { 'a', 'm', 'o', 's' };
static const symbol s_8_71[6] = { 0xE1, 'b', 'a', 'm', 'o', 's' };
static const symbol s_8_72[6] = { 0xE1, 'r', 'a', 'm', 'o', 's' };
static const symbol s_8_73[7] = { 'i', 0xE9, 'r', 'a', 'm', 'o', 's' };
static const symbol s_8_74[5] = { 0xED, 'a', 'm', 'o', 's' };
static const symbol s_8_75[7] = { 'a', 'r', 0xED, 'a', 'm', 'o', 's' };
static const symbol s_8_76[7] = { 'e', 'r', 0xED, 'a', 'm', 'o', 's' };
static const symbol s_8_77[7] = { 'i', 'r', 0xED, 'a', 'm', 'o', 's' };
static const symbol s_8_78[4] = { 'e', 'm', 'o', 's' };
static const symbol s_8_79[6] = { 'a', 'r', 'e', 'm', 'o', 's' };
static const symbol s_8_80[6] = { 'e', 'r', 'e', 'm', 'o', 's' };
static const symbol s_8_81[6] = { 'i', 'r', 'e', 'm', 'o', 's' };
static const symbol s_8_82[6] = { 0xE1, 's', 'e', 'm', 'o', 's' };
static const symbol s_8_83[7] = { 'i', 0xE9, 's', 'e', 'm', 'o', 's' };
static const symbol s_8_84[4] = { 'i', 'm', 'o', 's' };
static const symbol s_8_85[4] = { 'a', 'r', 0xE1, 's' };
static const symbol s_8_86[4] = { 'e', 'r', 0xE1, 's' };
static const symbol s_8_87[4] = { 'i', 'r', 0xE1, 's' };
static const symbol s_8_88[2] = { 0xED, 's' };
static const symbol s_8_89[3] = { 'a', 'r', 0xE1 };
static const symbol s_8_90[3] = { 'e', 'r', 0xE1 };
static const symbol s_8_91[3] = { 'i', 'r', 0xE1 };
static const symbol s_8_92[3] = { 'a', 'r', 0xE9 };
static const symbol s_8_93[3] = { 'e', 'r', 0xE9 };
static const symbol s_8_94[3] = { 'i', 'r', 0xE9 };
static const symbol s_8_95[2] = { 'i', 0xF3 };
static const struct among a_8[96] = {
{ 3, s_8_0, 0, 2, 0},
{ 3, s_8_1, 0, 2, 0},
{ 3, s_8_2, 0, 2, 0},
{ 3, s_8_3, 0, 2, 0},
{ 4, s_8_4, 0, 2, 0},
{ 2, s_8_5, 0, 2, 0},
{ 4, s_8_6, -1, 2, 0},
{ 4, s_8_7, -2, 2, 0},
{ 4, s_8_8, -3, 2, 0},
{ 2, s_8_9, 0, 2, 0},
{ 2, s_8_10, 0, 2, 0},
{ 2, s_8_11, 0, 2, 0},
{ 3, s_8_12, 0, 2, 0},
{ 4, s_8_13, 0, 2, 0},
{ 4, s_8_14, 0, 2, 0},
{ 4, s_8_15, 0, 2, 0},
{ 2, s_8_16, 0, 2, 0},
{ 4, s_8_17, -1, 2, 0},
{ 4, s_8_18, -2, 2, 0},
{ 5, s_8_19, -3, 2, 0},
{ 3, s_8_20, -4, 2, 0},
{ 5, s_8_21, -1, 2, 0},
{ 5, s_8_22, -2, 2, 0},
{ 5, s_8_23, -3, 2, 0},
{ 2, s_8_24, 0, 1, 0},
{ 4, s_8_25, -1, 2, 0},
{ 5, s_8_26, -2, 2, 0},
{ 4, s_8_27, 0, 2, 0},
{ 5, s_8_28, 0, 2, 0},
{ 4, s_8_29, 0, 2, 0},
{ 4, s_8_30, 0, 2, 0},
{ 4, s_8_31, 0, 2, 0},
{ 3, s_8_32, 0, 2, 0},
{ 3, s_8_33, 0, 2, 0},
{ 4, s_8_34, 0, 2, 0},
{ 5, s_8_35, 0, 2, 0},
{ 2, s_8_36, 0, 2, 0},
{ 2, s_8_37, 0, 2, 0},
{ 2, s_8_38, 0, 2, 0},
{ 2, s_8_39, 0, 2, 0},
{ 4, s_8_40, -1, 2, 0},
{ 4, s_8_41, -2, 2, 0},
{ 4, s_8_42, -3, 2, 0},
{ 4, s_8_43, -4, 2, 0},
{ 5, s_8_44, -5, 2, 0},
{ 3, s_8_45, -6, 2, 0},
{ 5, s_8_46, -1, 2, 0},
{ 5, s_8_47, -2, 2, 0},
{ 5, s_8_48, -3, 2, 0},
{ 2, s_8_49, 0, 1, 0},
{ 4, s_8_50, -1, 2, 0},
{ 5, s_8_51, -2, 2, 0},
{ 5, s_8_52, 0, 2, 0},
{ 5, s_8_53, 0, 2, 0},
{ 6, s_8_54, 0, 2, 0},
{ 4, s_8_55, 0, 2, 0},
{ 6, s_8_56, -1, 2, 0},
{ 6, s_8_57, -2, 2, 0},
{ 6, s_8_58, -3, 2, 0},
{ 5, s_8_59, 0, 2, 0},
{ 6, s_8_60, 0, 2, 0},
{ 6, s_8_61, 0, 2, 0},
{ 6, s_8_62, 0, 2, 0},
{ 3, s_8_63, 0, 2, 0},
{ 3, s_8_64, 0, 1, 0},
{ 5, s_8_65, -1, 2, 0},
{ 5, s_8_66, -2, 2, 0},
{ 5, s_8_67, -3, 2, 0},
{ 4, s_8_68, 0, 2, 0},
{ 4, s_8_69, 0, 2, 0},
{ 4, s_8_70, 0, 2, 0},
{ 6, s_8_71, -1, 2, 0},
{ 6, s_8_72, -2, 2, 0},
{ 7, s_8_73, -3, 2, 0},
{ 5, s_8_74, -4, 2, 0},
{ 7, s_8_75, -1, 2, 0},
{ 7, s_8_76, -2, 2, 0},
{ 7, s_8_77, -3, 2, 0},
{ 4, s_8_78, 0, 1, 0},
{ 6, s_8_79, -1, 2, 0},
{ 6, s_8_80, -2, 2, 0},
{ 6, s_8_81, -3, 2, 0},
{ 6, s_8_82, -4, 2, 0},
{ 7, s_8_83, -5, 2, 0},
{ 4, s_8_84, 0, 2, 0},
{ 4, s_8_85, 0, 2, 0},
{ 4, s_8_86, 0, 2, 0},
{ 4, s_8_87, 0, 2, 0},
{ 2, s_8_88, 0, 2, 0},
{ 3, s_8_89, 0, 2, 0},
{ 3, s_8_90, 0, 2, 0},
{ 3, s_8_91, 0, 2, 0},
{ 3, s_8_92, 0, 2, 0},
{ 3, s_8_93, 0, 2, 0},
{ 3, s_8_94, 0, 2, 0},
{ 2, s_8_95, 0, 2, 0}
};

static const symbol s_9_0[1] = { 'a' };
static const symbol s_9_1[1] = { 'e' };
static const symbol s_9_2[1] = { 'o' };
static const symbol s_9_3[2] = { 'o', 's' };
static const symbol s_9_4[1] = { 0xE1 };
static const symbol s_9_5[1] = { 0xE9 };
static const symbol s_9_6[1] = { 0xED };
static const symbol s_9_7[1] = { 0xF3 };
static const struct among a_9[8] = {
{ 1, s_9_0, 0, 1, 0},
{ 1, s_9_1, 0, 2, 0},
{ 1, s_9_2, 0, 1, 0},
{ 2, s_9_3, 0, 1, 0},
{ 1, s_9_4, 0, 1, 0},
{ 1, s_9_5, 0, 2, 0},
{ 1, s_9_6, 0, 1, 0},
{ 1, s_9_7, 0, 1, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 10 };

extern int spanish_stem(struct SN_env * z) {
    int among_var;
    int i_p2;
    int i_p1;
    int i_pV;
    i_pV = z->l;
    i_p1 = z->l;
    i_p2 = z->l;
    {
        int v_1 = z->c;
        do {
            int v_2 = z->c;
            if (in_grouping(z, g_v, 97, 252, 0)) goto lab2;
            do {
                int v_3 = z->c;
                if (out_grouping(z, g_v, 97, 252, 0)) goto lab3;
                {
                    int ret = out_grouping(z, g_v, 97, 252, 1);
                    if (ret < 0) goto lab3;
                    z->c += ret;
                }
                break;
            lab3:
                z->c = v_3;
                if (in_grouping(z, g_v, 97, 252, 0)) goto lab2;
                {
                    int ret = in_grouping(z, g_v, 97, 252, 1);
                    if (ret < 0) goto lab2;
                    z->c += ret;
                }
            } while (0);
            break;
        lab2:
            z->c = v_2;
            if (out_grouping(z, g_v, 97, 252, 0)) goto lab1;
            do {
                int v_4 = z->c;
                if (out_grouping(z, g_v, 97, 252, 0)) goto lab4;
                {
                    int ret = out_grouping(z, g_v, 97, 252, 1);
                    if (ret < 0) goto lab4;
                    z->c += ret;
                }
                break;
            lab4:
                z->c = v_4;
                if (in_grouping(z, g_v, 97, 252, 0)) goto lab1;
                if (z->c >= z->l) goto lab1;
                z->c++;
            } while (0);
        } while (0);
        i_pV = z->c;
    lab1:
        z->c = v_1;
    }
    {
        int v_5 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 252, 1);
            if (ret < 0) goto lab5;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 252, 1);
            if (ret < 0) goto lab5;
            z->c += ret;
        }
        i_p1 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 252, 1);
            if (ret < 0) goto lab5;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 252, 1);
            if (ret < 0) goto lab5;
            z->c += ret;
        }
        i_p2 = z->c;
    lab5:
        z->c = v_5;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_6 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((557090 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab6;
        if (!find_among_b(z, a_1, 13, 0)) goto lab6;
        z->bra = z->c;
        if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 111 && z->p[z->c - 1] != 114)) goto lab6;
        among_var = find_among_b(z, a_2, 11, 0);
        if (!among_var) goto lab6;
        if (i_pV > z->c) goto lab6;
        switch (among_var) {
            case 1:
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 5, s_0);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 4, s_1);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 2, s_2);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 2, s_3);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 2, s_4);
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
                if (z->c <= z->lb || z->p[z->c - 1] != 'u') goto lab6;
                z->c--;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab6:
        z->c = z->l - v_6;
    }
    {
        int v_7 = z->l - z->c;
        do {
            int v_8 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 2 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((835634 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab8;
            among_var = find_among_b(z, a_6, 48, 0);
            if (!among_var) goto lab8;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_9 = z->l - z->c;
                        z->ket = z->c;
                        if (!(eq_s_b(z, 2, s_5))) { z->c = z->l - v_9; goto lab9; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_9; goto lab9; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    lab9:
                        ;
                    }
                    break;
                case 3:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_from_s(z, 3, s_6);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_from_s(z, 1, s_7);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_from_s(z, 4, s_8);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    if (i_p1 > z->c) goto lab8;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_10 = z->l - z->c;
                        z->ket = z->c;
                        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4718616 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->c = z->l - v_10; goto lab10; }
                        among_var = find_among_b(z, a_3, 4, 0);
                        if (!among_var) { z->c = z->l - v_10; goto lab10; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_10; goto lab10; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        switch (among_var) {
                            case 1:
                                z->ket = z->c;
                                if (!(eq_s_b(z, 2, s_9))) { z->c = z->l - v_10; goto lab10; }
                                z->bra = z->c;
                                if (i_p2 > z->c) { z->c = z->l - v_10; goto lab10; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                        }
                    lab10:
                        ;
                    }
                    break;
                case 7:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_11 = z->l - z->c;
                        z->ket = z->c;
                        if (z->c - 3 <= z->lb || z->p[z->c - 1] != 101) { z->c = z->l - v_11; goto lab11; }
                        if (!find_among_b(z, a_4, 3, 0)) { z->c = z->l - v_11; goto lab11; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_11; goto lab11; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    lab11:
                        ;
                    }
                    break;
                case 8:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_12 = z->l - z->c;
                        z->ket = z->c;
                        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4198408 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->c = z->l - v_12; goto lab12; }
                        if (!find_among_b(z, a_5, 3, 0)) { z->c = z->l - v_12; goto lab12; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_12; goto lab12; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    lab12:
                        ;
                    }
                    break;
                case 9:
                    if (i_p2 > z->c) goto lab8;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_13 = z->l - z->c;
                        z->ket = z->c;
                        if (!(eq_s_b(z, 2, s_10))) { z->c = z->l - v_13; goto lab13; }
                        z->bra = z->c;
                        if (i_p2 > z->c) { z->c = z->l - v_13; goto lab13; }
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    lab13:
                        ;
                    }
                    break;
            }
            break;
        lab8:
            z->c = z->l - v_8;
            {
                int v_14;
                if (z->c < i_pV) goto lab14;
                v_14 = z->lb; z->lb = i_pV;
                z->ket = z->c;
                if (!find_among_b(z, a_7, 12, 0)) { z->lb = v_14; goto lab14; }
                z->bra = z->c;
                z->lb = v_14;
            }
            if (z->c <= z->lb || z->p[z->c - 1] != 'u') goto lab14;
            z->c--;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        lab14:
            z->c = z->l - v_8;
            {
                int v_15;
                if (z->c < i_pV) goto lab7;
                v_15 = z->lb; z->lb = i_pV;
                z->ket = z->c;
                among_var = find_among_b(z, a_8, 96, 0);
                if (!among_var) { z->lb = v_15; goto lab7; }
                z->bra = z->c;
                z->lb = v_15;
            }
            switch (among_var) {
                case 1:
                    {
                        int v_16 = z->l - z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] != 'u') { z->c = z->l - v_16; goto lab15; }
                        z->c--;
                        {
                            int v_17 = z->l - z->c;
                            if (z->c <= z->lb || z->p[z->c - 1] != 'g') { z->c = z->l - v_16; goto lab15; }
                            z->c--;
                            z->c = z->l - v_17;
                        }
                    lab15:
                        ;
                    }
                    z->bra = z->c;
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
            }
        } while (0);
    lab7:
        z->c = z->l - v_7;
    }
    {
        int v_18 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_9, 8, 0);
        if (!among_var) goto lab16;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                if (i_pV > z->c) goto lab16;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                if (i_pV > z->c) goto lab16;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int v_19 = z->l - z->c;
                    z->ket = z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'u') { z->c = z->l - v_19; goto lab17; }
                    z->c--;
                    z->bra = z->c;
                    {
                        int v_20 = z->l - z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] != 'g') { z->c = z->l - v_19; goto lab17; }
                        z->c--;
                        z->c = z->l - v_20;
                    }
                    if (i_pV > z->c) { z->c = z->l - v_19; goto lab17; }
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                lab17:
                    ;
                }
                break;
        }
    lab16:
        z->c = z->l - v_18;
    }
    z->c = z->lb;
    {
        int v_21 = z->c;
        while (1) {
            int v_22 = z->c;
            z->bra = z->c;
            if (z->c >= z->l || z->p[z->c + 0] >> 5 != 7 || !((67641858 >> (z->p[z->c + 0] & 0x1f)) & 1)) among_var = 6; else
            among_var = find_among(z, a_0, 6, 0);
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 1, s_11);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 1, s_12);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    {
                        int ret = slice_from_s(z, 1, s_13);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    {
                        int ret = slice_from_s(z, 1, s_14);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    {
                        int ret = slice_from_s(z, 1, s_15);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    if (z->c >= z->l) goto lab19;
                    z->c++;
                    break;
            }
            continue;
        lab19:
            z->c = v_22;
            break;
        }
        z->c = v_21;
    }
    return 1;
}

extern struct SN_env * spanish_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
