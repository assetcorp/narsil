/*
 * Generated from algorithms/portuguese.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "portuguese_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int portuguese_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 'a', '~' };
static const symbol s_1[] = { 'o', '~' };
static const symbol s_2[] = { 'l', 'o', 'g' };
static const symbol s_3[] = { 'u' };
static const symbol s_4[] = { 'e', 'n', 't', 'e' };
static const symbol s_5[] = { 'a', 't' };
static const symbol s_6[] = { 'a', 't' };
static const symbol s_7[] = { 'i', 'r' };
static const symbol s_8[] = { 'c' };
static const symbol s_9[] = { 0xE3 };
static const symbol s_10[] = { 0xF5 };

static const symbol s_0_1[1] = { 0xE3 };
static const symbol s_0_2[1] = { 0xF5 };
static const struct among a_0[3] = {
{ 0, 0, 0, 3, 0},
{ 1, s_0_1, -1, 1, 0},
{ 1, s_0_2, -2, 2, 0}
};

static const symbol s_1_1[2] = { 'a', '~' };
static const symbol s_1_2[2] = { 'o', '~' };
static const struct among a_1[3] = {
{ 0, 0, 0, 3, 0},
{ 2, s_1_1, -1, 1, 0},
{ 2, s_1_2, -2, 2, 0}
};

static const symbol s_2_0[2] = { 'i', 'c' };
static const symbol s_2_1[2] = { 'a', 'd' };
static const symbol s_2_2[2] = { 'o', 's' };
static const symbol s_2_3[2] = { 'i', 'v' };
static const struct among a_2[4] = {
{ 2, s_2_0, 0, -1, 0},
{ 2, s_2_1, 0, -1, 0},
{ 2, s_2_2, 0, -1, 0},
{ 2, s_2_3, 0, 1, 0}
};

static const symbol s_3_0[4] = { 'a', 'n', 't', 'e' };
static const symbol s_3_1[4] = { 'a', 'v', 'e', 'l' };
static const symbol s_3_2[4] = { 0xED, 'v', 'e', 'l' };
static const struct among a_3[3] = {
{ 4, s_3_0, 0, 1, 0},
{ 4, s_3_1, 0, 1, 0},
{ 4, s_3_2, 0, 1, 0}
};

static const symbol s_4_0[2] = { 'i', 'c' };
static const symbol s_4_1[4] = { 'a', 'b', 'i', 'l' };
static const symbol s_4_2[2] = { 'i', 'v' };
static const struct among a_4[3] = {
{ 2, s_4_0, 0, 1, 0},
{ 4, s_4_1, 0, 1, 0},
{ 2, s_4_2, 0, 1, 0}
};

static const symbol s_5_0[3] = { 'i', 'c', 'a' };
static const symbol s_5_1[5] = { 0xE2, 'n', 'c', 'i', 'a' };
static const symbol s_5_2[5] = { 0xEA, 'n', 'c', 'i', 'a' };
static const symbol s_5_3[5] = { 'l', 'o', 'g', 'i', 'a' };
static const symbol s_5_4[3] = { 'i', 'r', 'a' };
static const symbol s_5_5[5] = { 'a', 'd', 'o', 'r', 'a' };
static const symbol s_5_6[3] = { 'o', 's', 'a' };
static const symbol s_5_7[4] = { 'i', 's', 't', 'a' };
static const symbol s_5_8[3] = { 'i', 'v', 'a' };
static const symbol s_5_9[3] = { 'e', 'z', 'a' };
static const symbol s_5_10[5] = { 'i', 'd', 'a', 'd', 'e' };
static const symbol s_5_11[4] = { 'a', 'n', 't', 'e' };
static const symbol s_5_12[5] = { 'm', 'e', 'n', 't', 'e' };
static const symbol s_5_13[6] = { 'a', 'm', 'e', 'n', 't', 'e' };
static const symbol s_5_14[4] = { 0xE1, 'v', 'e', 'l' };
static const symbol s_5_15[4] = { 0xED, 'v', 'e', 'l' };
static const symbol s_5_16[3] = { 'i', 'c', 'o' };
static const symbol s_5_17[4] = { 'i', 's', 'm', 'o' };
static const symbol s_5_18[3] = { 'o', 's', 'o' };
static const symbol s_5_19[6] = { 'a', 'm', 'e', 'n', 't', 'o' };
static const symbol s_5_20[6] = { 'i', 'm', 'e', 'n', 't', 'o' };
static const symbol s_5_21[3] = { 'i', 'v', 'o' };
static const symbol s_5_22[5] = { 'a', 0xE7, 'a', '~', 'o' };
static const symbol s_5_23[5] = { 'u', 0xE7, 'a', '~', 'o' };
static const symbol s_5_24[4] = { 'a', 'd', 'o', 'r' };
static const symbol s_5_25[4] = { 'i', 'c', 'a', 's' };
static const symbol s_5_26[6] = { 0xEA, 'n', 'c', 'i', 'a', 's' };
static const symbol s_5_27[6] = { 'l', 'o', 'g', 'i', 'a', 's' };
static const symbol s_5_28[4] = { 'i', 'r', 'a', 's' };
static const symbol s_5_29[6] = { 'a', 'd', 'o', 'r', 'a', 's' };
static const symbol s_5_30[4] = { 'o', 's', 'a', 's' };
static const symbol s_5_31[5] = { 'i', 's', 't', 'a', 's' };
static const symbol s_5_32[4] = { 'i', 'v', 'a', 's' };
static const symbol s_5_33[4] = { 'e', 'z', 'a', 's' };
static const symbol s_5_34[6] = { 'i', 'd', 'a', 'd', 'e', 's' };
static const symbol s_5_35[6] = { 'a', 'd', 'o', 'r', 'e', 's' };
static const symbol s_5_36[5] = { 'a', 'n', 't', 'e', 's' };
static const symbol s_5_37[6] = { 'a', 0xE7, 'o', '~', 'e', 's' };
static const symbol s_5_38[6] = { 'u', 0xE7, 'o', '~', 'e', 's' };
static const symbol s_5_39[4] = { 'i', 'c', 'o', 's' };
static const symbol s_5_40[5] = { 'i', 's', 'm', 'o', 's' };
static const symbol s_5_41[4] = { 'o', 's', 'o', 's' };
static const symbol s_5_42[7] = { 'a', 'm', 'e', 'n', 't', 'o', 's' };
static const symbol s_5_43[7] = { 'i', 'm', 'e', 'n', 't', 'o', 's' };
static const symbol s_5_44[4] = { 'i', 'v', 'o', 's' };
static const struct among a_5[45] = {
{ 3, s_5_0, 0, 1, 0},
{ 5, s_5_1, 0, 1, 0},
{ 5, s_5_2, 0, 4, 0},
{ 5, s_5_3, 0, 2, 0},
{ 3, s_5_4, 0, 9, 0},
{ 5, s_5_5, 0, 1, 0},
{ 3, s_5_6, 0, 1, 0},
{ 4, s_5_7, 0, 1, 0},
{ 3, s_5_8, 0, 8, 0},
{ 3, s_5_9, 0, 1, 0},
{ 5, s_5_10, 0, 7, 0},
{ 4, s_5_11, 0, 1, 0},
{ 5, s_5_12, 0, 6, 0},
{ 6, s_5_13, -1, 5, 0},
{ 4, s_5_14, 0, 1, 0},
{ 4, s_5_15, 0, 1, 0},
{ 3, s_5_16, 0, 1, 0},
{ 4, s_5_17, 0, 1, 0},
{ 3, s_5_18, 0, 1, 0},
{ 6, s_5_19, 0, 1, 0},
{ 6, s_5_20, 0, 1, 0},
{ 3, s_5_21, 0, 8, 0},
{ 5, s_5_22, 0, 1, 0},
{ 5, s_5_23, 0, 3, 0},
{ 4, s_5_24, 0, 1, 0},
{ 4, s_5_25, 0, 1, 0},
{ 6, s_5_26, 0, 4, 0},
{ 6, s_5_27, 0, 2, 0},
{ 4, s_5_28, 0, 9, 0},
{ 6, s_5_29, 0, 1, 0},
{ 4, s_5_30, 0, 1, 0},
{ 5, s_5_31, 0, 1, 0},
{ 4, s_5_32, 0, 8, 0},
{ 4, s_5_33, 0, 1, 0},
{ 6, s_5_34, 0, 7, 0},
{ 6, s_5_35, 0, 1, 0},
{ 5, s_5_36, 0, 1, 0},
{ 6, s_5_37, 0, 1, 0},
{ 6, s_5_38, 0, 3, 0},
{ 4, s_5_39, 0, 1, 0},
{ 5, s_5_40, 0, 1, 0},
{ 4, s_5_41, 0, 1, 0},
{ 7, s_5_42, 0, 1, 0},
{ 7, s_5_43, 0, 1, 0},
{ 4, s_5_44, 0, 8, 0}
};

static const symbol s_6_0[3] = { 'a', 'd', 'a' };
static const symbol s_6_1[3] = { 'i', 'd', 'a' };
static const symbol s_6_2[2] = { 'i', 'a' };
static const symbol s_6_3[4] = { 'a', 'r', 'i', 'a' };
static const symbol s_6_4[4] = { 'e', 'r', 'i', 'a' };
static const symbol s_6_5[4] = { 'i', 'r', 'i', 'a' };
static const symbol s_6_6[3] = { 'a', 'r', 'a' };
static const symbol s_6_7[3] = { 'e', 'r', 'a' };
static const symbol s_6_8[3] = { 'i', 'r', 'a' };
static const symbol s_6_9[3] = { 'a', 'v', 'a' };
static const symbol s_6_10[4] = { 'a', 's', 's', 'e' };
static const symbol s_6_11[4] = { 'e', 's', 's', 'e' };
static const symbol s_6_12[4] = { 'i', 's', 's', 'e' };
static const symbol s_6_13[4] = { 'a', 's', 't', 'e' };
static const symbol s_6_14[4] = { 'e', 's', 't', 'e' };
static const symbol s_6_15[4] = { 'i', 's', 't', 'e' };
static const symbol s_6_16[2] = { 'e', 'i' };
static const symbol s_6_17[4] = { 'a', 'r', 'e', 'i' };
static const symbol s_6_18[4] = { 'e', 'r', 'e', 'i' };
static const symbol s_6_19[4] = { 'i', 'r', 'e', 'i' };
static const symbol s_6_20[2] = { 'a', 'm' };
static const symbol s_6_21[3] = { 'i', 'a', 'm' };
static const symbol s_6_22[5] = { 'a', 'r', 'i', 'a', 'm' };
static const symbol s_6_23[5] = { 'e', 'r', 'i', 'a', 'm' };
static const symbol s_6_24[5] = { 'i', 'r', 'i', 'a', 'm' };
static const symbol s_6_25[4] = { 'a', 'r', 'a', 'm' };
static const symbol s_6_26[4] = { 'e', 'r', 'a', 'm' };
static const symbol s_6_27[4] = { 'i', 'r', 'a', 'm' };
static const symbol s_6_28[4] = { 'a', 'v', 'a', 'm' };
static const symbol s_6_29[2] = { 'e', 'm' };
static const symbol s_6_30[4] = { 'a', 'r', 'e', 'm' };
static const symbol s_6_31[4] = { 'e', 'r', 'e', 'm' };
static const symbol s_6_32[4] = { 'i', 'r', 'e', 'm' };
static const symbol s_6_33[5] = { 'a', 's', 's', 'e', 'm' };
static const symbol s_6_34[5] = { 'e', 's', 's', 'e', 'm' };
static const symbol s_6_35[5] = { 'i', 's', 's', 'e', 'm' };
static const symbol s_6_36[3] = { 'a', 'd', 'o' };
static const symbol s_6_37[3] = { 'i', 'd', 'o' };
static const symbol s_6_38[4] = { 'a', 'n', 'd', 'o' };
static const symbol s_6_39[4] = { 'e', 'n', 'd', 'o' };
static const symbol s_6_40[4] = { 'i', 'n', 'd', 'o' };
static const symbol s_6_41[5] = { 'a', 'r', 'a', '~', 'o' };
static const symbol s_6_42[5] = { 'e', 'r', 'a', '~', 'o' };
static const symbol s_6_43[5] = { 'i', 'r', 'a', '~', 'o' };
static const symbol s_6_44[2] = { 'a', 'r' };
static const symbol s_6_45[2] = { 'e', 'r' };
static const symbol s_6_46[2] = { 'i', 'r' };
static const symbol s_6_47[2] = { 'a', 's' };
static const symbol s_6_48[4] = { 'a', 'd', 'a', 's' };
static const symbol s_6_49[4] = { 'i', 'd', 'a', 's' };
static const symbol s_6_50[3] = { 'i', 'a', 's' };
static const symbol s_6_51[5] = { 'a', 'r', 'i', 'a', 's' };
static const symbol s_6_52[5] = { 'e', 'r', 'i', 'a', 's' };
static const symbol s_6_53[5] = { 'i', 'r', 'i', 'a', 's' };
static const symbol s_6_54[4] = { 'a', 'r', 'a', 's' };
static const symbol s_6_55[4] = { 'e', 'r', 'a', 's' };
static const symbol s_6_56[4] = { 'i', 'r', 'a', 's' };
static const symbol s_6_57[4] = { 'a', 'v', 'a', 's' };
static const symbol s_6_58[2] = { 'e', 's' };
static const symbol s_6_59[5] = { 'a', 'r', 'd', 'e', 's' };
static const symbol s_6_60[5] = { 'e', 'r', 'd', 'e', 's' };
static const symbol s_6_61[5] = { 'i', 'r', 'd', 'e', 's' };
static const symbol s_6_62[4] = { 'a', 'r', 'e', 's' };
static const symbol s_6_63[4] = { 'e', 'r', 'e', 's' };
static const symbol s_6_64[4] = { 'i', 'r', 'e', 's' };
static const symbol s_6_65[5] = { 'a', 's', 's', 'e', 's' };
static const symbol s_6_66[5] = { 'e', 's', 's', 'e', 's' };
static const symbol s_6_67[5] = { 'i', 's', 's', 'e', 's' };
static const symbol s_6_68[5] = { 'a', 's', 't', 'e', 's' };
static const symbol s_6_69[5] = { 'e', 's', 't', 'e', 's' };
static const symbol s_6_70[5] = { 'i', 's', 't', 'e', 's' };
static const symbol s_6_71[2] = { 'i', 's' };
static const symbol s_6_72[3] = { 'a', 'i', 's' };
static const symbol s_6_73[3] = { 'e', 'i', 's' };
static const symbol s_6_74[5] = { 'a', 'r', 'e', 'i', 's' };
static const symbol s_6_75[5] = { 'e', 'r', 'e', 'i', 's' };
static const symbol s_6_76[5] = { 'i', 'r', 'e', 'i', 's' };
static const symbol s_6_77[5] = { 0xE1, 'r', 'e', 'i', 's' };
static const symbol s_6_78[5] = { 0xE9, 'r', 'e', 'i', 's' };
static const symbol s_6_79[5] = { 0xED, 'r', 'e', 'i', 's' };
static const symbol s_6_80[6] = { 0xE1, 's', 's', 'e', 'i', 's' };
static const symbol s_6_81[6] = { 0xE9, 's', 's', 'e', 'i', 's' };
static const symbol s_6_82[6] = { 0xED, 's', 's', 'e', 'i', 's' };
static const symbol s_6_83[5] = { 0xE1, 'v', 'e', 'i', 's' };
static const symbol s_6_84[4] = { 0xED, 'e', 'i', 's' };
static const symbol s_6_85[6] = { 'a', 'r', 0xED, 'e', 'i', 's' };
static const symbol s_6_86[6] = { 'e', 'r', 0xED, 'e', 'i', 's' };
static const symbol s_6_87[6] = { 'i', 'r', 0xED, 'e', 'i', 's' };
static const symbol s_6_88[4] = { 'a', 'd', 'o', 's' };
static const symbol s_6_89[4] = { 'i', 'd', 'o', 's' };
static const symbol s_6_90[4] = { 'a', 'm', 'o', 's' };
static const symbol s_6_91[6] = { 0xE1, 'r', 'a', 'm', 'o', 's' };
static const symbol s_6_92[6] = { 0xE9, 'r', 'a', 'm', 'o', 's' };
static const symbol s_6_93[6] = { 0xED, 'r', 'a', 'm', 'o', 's' };
static const symbol s_6_94[6] = { 0xE1, 'v', 'a', 'm', 'o', 's' };
static const symbol s_6_95[5] = { 0xED, 'a', 'm', 'o', 's' };
static const symbol s_6_96[7] = { 'a', 'r', 0xED, 'a', 'm', 'o', 's' };
static const symbol s_6_97[7] = { 'e', 'r', 0xED, 'a', 'm', 'o', 's' };
static const symbol s_6_98[7] = { 'i', 'r', 0xED, 'a', 'm', 'o', 's' };
static const symbol s_6_99[4] = { 'e', 'm', 'o', 's' };
static const symbol s_6_100[6] = { 'a', 'r', 'e', 'm', 'o', 's' };
static const symbol s_6_101[6] = { 'e', 'r', 'e', 'm', 'o', 's' };
static const symbol s_6_102[6] = { 'i', 'r', 'e', 'm', 'o', 's' };
static const symbol s_6_103[7] = { 0xE1, 's', 's', 'e', 'm', 'o', 's' };
static const symbol s_6_104[7] = { 0xEA, 's', 's', 'e', 'm', 'o', 's' };
static const symbol s_6_105[7] = { 0xED, 's', 's', 'e', 'm', 'o', 's' };
static const symbol s_6_106[4] = { 'i', 'm', 'o', 's' };
static const symbol s_6_107[5] = { 'a', 'r', 'm', 'o', 's' };
static const symbol s_6_108[5] = { 'e', 'r', 'm', 'o', 's' };
static const symbol s_6_109[5] = { 'i', 'r', 'm', 'o', 's' };
static const symbol s_6_110[4] = { 0xE1, 'm', 'o', 's' };
static const symbol s_6_111[4] = { 'a', 'r', 0xE1, 's' };
static const symbol s_6_112[4] = { 'e', 'r', 0xE1, 's' };
static const symbol s_6_113[4] = { 'i', 'r', 0xE1, 's' };
static const symbol s_6_114[2] = { 'e', 'u' };
static const symbol s_6_115[2] = { 'i', 'u' };
static const symbol s_6_116[2] = { 'o', 'u' };
static const symbol s_6_117[3] = { 'a', 'r', 0xE1 };
static const symbol s_6_118[3] = { 'e', 'r', 0xE1 };
static const symbol s_6_119[3] = { 'i', 'r', 0xE1 };
static const struct among a_6[120] = {
{ 3, s_6_0, 0, 1, 0},
{ 3, s_6_1, 0, 1, 0},
{ 2, s_6_2, 0, 1, 0},
{ 4, s_6_3, -1, 1, 0},
{ 4, s_6_4, -2, 1, 0},
{ 4, s_6_5, -3, 1, 0},
{ 3, s_6_6, 0, 1, 0},
{ 3, s_6_7, 0, 1, 0},
{ 3, s_6_8, 0, 1, 0},
{ 3, s_6_9, 0, 1, 0},
{ 4, s_6_10, 0, 1, 0},
{ 4, s_6_11, 0, 1, 0},
{ 4, s_6_12, 0, 1, 0},
{ 4, s_6_13, 0, 1, 0},
{ 4, s_6_14, 0, 1, 0},
{ 4, s_6_15, 0, 1, 0},
{ 2, s_6_16, 0, 1, 0},
{ 4, s_6_17, -1, 1, 0},
{ 4, s_6_18, -2, 1, 0},
{ 4, s_6_19, -3, 1, 0},
{ 2, s_6_20, 0, 1, 0},
{ 3, s_6_21, -1, 1, 0},
{ 5, s_6_22, -1, 1, 0},
{ 5, s_6_23, -2, 1, 0},
{ 5, s_6_24, -3, 1, 0},
{ 4, s_6_25, -5, 1, 0},
{ 4, s_6_26, -6, 1, 0},
{ 4, s_6_27, -7, 1, 0},
{ 4, s_6_28, -8, 1, 0},
{ 2, s_6_29, 0, 1, 0},
{ 4, s_6_30, -1, 1, 0},
{ 4, s_6_31, -2, 1, 0},
{ 4, s_6_32, -3, 1, 0},
{ 5, s_6_33, -4, 1, 0},
{ 5, s_6_34, -5, 1, 0},
{ 5, s_6_35, -6, 1, 0},
{ 3, s_6_36, 0, 1, 0},
{ 3, s_6_37, 0, 1, 0},
{ 4, s_6_38, 0, 1, 0},
{ 4, s_6_39, 0, 1, 0},
{ 4, s_6_40, 0, 1, 0},
{ 5, s_6_41, 0, 1, 0},
{ 5, s_6_42, 0, 1, 0},
{ 5, s_6_43, 0, 1, 0},
{ 2, s_6_44, 0, 1, 0},
{ 2, s_6_45, 0, 1, 0},
{ 2, s_6_46, 0, 1, 0},
{ 2, s_6_47, 0, 1, 0},
{ 4, s_6_48, -1, 1, 0},
{ 4, s_6_49, -2, 1, 0},
{ 3, s_6_50, -3, 1, 0},
{ 5, s_6_51, -1, 1, 0},
{ 5, s_6_52, -2, 1, 0},
{ 5, s_6_53, -3, 1, 0},
{ 4, s_6_54, -7, 1, 0},
{ 4, s_6_55, -8, 1, 0},
{ 4, s_6_56, -9, 1, 0},
{ 4, s_6_57, -10, 1, 0},
{ 2, s_6_58, 0, 1, 0},
{ 5, s_6_59, -1, 1, 0},
{ 5, s_6_60, -2, 1, 0},
{ 5, s_6_61, -3, 1, 0},
{ 4, s_6_62, -4, 1, 0},
{ 4, s_6_63, -5, 1, 0},
{ 4, s_6_64, -6, 1, 0},
{ 5, s_6_65, -7, 1, 0},
{ 5, s_6_66, -8, 1, 0},
{ 5, s_6_67, -9, 1, 0},
{ 5, s_6_68, -10, 1, 0},
{ 5, s_6_69, -11, 1, 0},
{ 5, s_6_70, -12, 1, 0},
{ 2, s_6_71, 0, 1, 0},
{ 3, s_6_72, -1, 1, 0},
{ 3, s_6_73, -2, 1, 0},
{ 5, s_6_74, -1, 1, 0},
{ 5, s_6_75, -2, 1, 0},
{ 5, s_6_76, -3, 1, 0},
{ 5, s_6_77, -4, 1, 0},
{ 5, s_6_78, -5, 1, 0},
{ 5, s_6_79, -6, 1, 0},
{ 6, s_6_80, -7, 1, 0},
{ 6, s_6_81, -8, 1, 0},
{ 6, s_6_82, -9, 1, 0},
{ 5, s_6_83, -10, 1, 0},
{ 4, s_6_84, -11, 1, 0},
{ 6, s_6_85, -1, 1, 0},
{ 6, s_6_86, -2, 1, 0},
{ 6, s_6_87, -3, 1, 0},
{ 4, s_6_88, 0, 1, 0},
{ 4, s_6_89, 0, 1, 0},
{ 4, s_6_90, 0, 1, 0},
{ 6, s_6_91, -1, 1, 0},
{ 6, s_6_92, -2, 1, 0},
{ 6, s_6_93, -3, 1, 0},
{ 6, s_6_94, -4, 1, 0},
{ 5, s_6_95, -5, 1, 0},
{ 7, s_6_96, -1, 1, 0},
{ 7, s_6_97, -2, 1, 0},
{ 7, s_6_98, -3, 1, 0},
{ 4, s_6_99, 0, 1, 0},
{ 6, s_6_100, -1, 1, 0},
{ 6, s_6_101, -2, 1, 0},
{ 6, s_6_102, -3, 1, 0},
{ 7, s_6_103, -4, 1, 0},
{ 7, s_6_104, -5, 1, 0},
{ 7, s_6_105, -6, 1, 0},
{ 4, s_6_106, 0, 1, 0},
{ 5, s_6_107, 0, 1, 0},
{ 5, s_6_108, 0, 1, 0},
{ 5, s_6_109, 0, 1, 0},
{ 4, s_6_110, 0, 1, 0},
{ 4, s_6_111, 0, 1, 0},
{ 4, s_6_112, 0, 1, 0},
{ 4, s_6_113, 0, 1, 0},
{ 2, s_6_114, 0, 1, 0},
{ 2, s_6_115, 0, 1, 0},
{ 2, s_6_116, 0, 1, 0},
{ 3, s_6_117, 0, 1, 0},
{ 3, s_6_118, 0, 1, 0},
{ 3, s_6_119, 0, 1, 0}
};

static const symbol s_7_0[1] = { 'a' };
static const symbol s_7_1[1] = { 'i' };
static const symbol s_7_2[1] = { 'o' };
static const symbol s_7_3[2] = { 'o', 's' };
static const symbol s_7_4[1] = { 0xE1 };
static const symbol s_7_5[1] = { 0xED };
static const symbol s_7_6[1] = { 0xF3 };
static const struct among a_7[7] = {
{ 1, s_7_0, 0, 1, 0},
{ 1, s_7_1, 0, 1, 0},
{ 1, s_7_2, 0, 1, 0},
{ 2, s_7_3, 0, 1, 0},
{ 1, s_7_4, 0, 1, 0},
{ 1, s_7_5, 0, 1, 0},
{ 1, s_7_6, 0, 1, 0}
};

static const symbol s_8_0[1] = { 'e' };
static const symbol s_8_1[1] = { 0xE7 };
static const symbol s_8_2[1] = { 0xE9 };
static const symbol s_8_3[1] = { 0xEA };
static const struct among a_8[4] = {
{ 1, s_8_0, 0, 1, 0},
{ 1, s_8_1, 0, 2, 0},
{ 1, s_8_2, 0, 1, 0},
{ 1, s_8_3, 0, 1, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 19, 12, 2 };

extern int portuguese_stem(struct SN_env * z) {
    int among_var;
    int i_p2;
    int i_p1;
    int i_pV;
    {
        int v_1 = z->c;
        while (1) {
            int v_2 = z->c;
            z->bra = z->c;
            if (z->c >= z->l || (z->p[z->c + 0] != 227 && z->p[z->c + 0] != 245)) among_var = 3; else
            among_var = find_among(z, a_0, 3, 0);
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 2, s_0);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 2, s_1);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    if (z->c >= z->l) goto lab1;
                    z->c++;
                    break;
            }
            continue;
        lab1:
            z->c = v_2;
            break;
        }
        z->c = v_1;
    }
    i_pV = z->l;
    i_p1 = z->l;
    i_p2 = z->l;
    {
        int v_3 = z->c;
        do {
            int v_4 = z->c;
            if (in_grouping(z, g_v, 97, 250, 0)) goto lab4;
            do {
                int v_5 = z->c;
                if (out_grouping(z, g_v, 97, 250, 0)) goto lab5;
                {
                    int ret = out_grouping(z, g_v, 97, 250, 1);
                    if (ret < 0) goto lab5;
                    z->c += ret;
                }
                break;
            lab5:
                z->c = v_5;
                if (in_grouping(z, g_v, 97, 250, 0)) goto lab4;
                {
                    int ret = in_grouping(z, g_v, 97, 250, 1);
                    if (ret < 0) goto lab4;
                    z->c += ret;
                }
            } while (0);
            break;
        lab4:
            z->c = v_4;
            if (out_grouping(z, g_v, 97, 250, 0)) goto lab3;
            do {
                int v_6 = z->c;
                if (out_grouping(z, g_v, 97, 250, 0)) goto lab6;
                {
                    int ret = out_grouping(z, g_v, 97, 250, 1);
                    if (ret < 0) goto lab6;
                    z->c += ret;
                }
                break;
            lab6:
                z->c = v_6;
                if (in_grouping(z, g_v, 97, 250, 0)) goto lab3;
                if (z->c >= z->l) goto lab3;
                z->c++;
            } while (0);
        } while (0);
        i_pV = z->c;
    lab3:
        z->c = v_3;
    }
    {
        int v_7 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab7;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab7;
            z->c += ret;
        }
        i_p1 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab7;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab7;
            z->c += ret;
        }
        i_p2 = z->c;
    lab7:
        z->c = v_7;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_8 = z->l - z->c;
        do {
            int v_9 = z->l - z->c;
            {
                int v_10 = z->l - z->c;
                do {
                    int v_11 = z->l - z->c;
                    z->ket = z->c;
                    if (z->c - 2 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((823330 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab10;
                    among_var = find_among_b(z, a_5, 45, 0);
                    if (!among_var) goto lab10;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            if (i_p2 > z->c) goto lab10;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            if (i_p2 > z->c) goto lab10;
                            {
                                int ret = slice_from_s(z, 3, s_2);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 3:
                            if (i_p2 > z->c) goto lab10;
                            {
                                int ret = slice_from_s(z, 1, s_3);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 4:
                            if (i_p2 > z->c) goto lab10;
                            {
                                int ret = slice_from_s(z, 4, s_4);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 5:
                            if (i_p1 > z->c) goto lab10;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_12 = z->l - z->c;
                                z->ket = z->c;
                                if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4718616 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->c = z->l - v_12; goto lab11; }
                                among_var = find_among_b(z, a_2, 4, 0);
                                if (!among_var) { z->c = z->l - v_12; goto lab11; }
                                z->bra = z->c;
                                if (i_p2 > z->c) { z->c = z->l - v_12; goto lab11; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                switch (among_var) {
                                    case 1:
                                        z->ket = z->c;
                                        if (!(eq_s_b(z, 2, s_5))) { z->c = z->l - v_12; goto lab11; }
                                        z->bra = z->c;
                                        if (i_p2 > z->c) { z->c = z->l - v_12; goto lab11; }
                                        {
                                            int ret = slice_del(z);
                                            if (ret < 0) return ret;
                                        }
                                        break;
                                }
                            lab11:
                                ;
                            }
                            break;
                        case 6:
                            if (i_p2 > z->c) goto lab10;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_13 = z->l - z->c;
                                z->ket = z->c;
                                if (z->c - 3 <= z->lb || (z->p[z->c - 1] != 101 && z->p[z->c - 1] != 108)) { z->c = z->l - v_13; goto lab12; }
                                if (!find_among_b(z, a_3, 3, 0)) { z->c = z->l - v_13; goto lab12; }
                                z->bra = z->c;
                                if (i_p2 > z->c) { z->c = z->l - v_13; goto lab12; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                            lab12:
                                ;
                            }
                            break;
                        case 7:
                            if (i_p2 > z->c) goto lab10;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_14 = z->l - z->c;
                                z->ket = z->c;
                                if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4198408 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->c = z->l - v_14; goto lab13; }
                                if (!find_among_b(z, a_4, 3, 0)) { z->c = z->l - v_14; goto lab13; }
                                z->bra = z->c;
                                if (i_p2 > z->c) { z->c = z->l - v_14; goto lab13; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                            lab13:
                                ;
                            }
                            break;
                        case 8:
                            if (i_p2 > z->c) goto lab10;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            {
                                int v_15 = z->l - z->c;
                                z->ket = z->c;
                                if (!(eq_s_b(z, 2, s_6))) { z->c = z->l - v_15; goto lab14; }
                                z->bra = z->c;
                                if (i_p2 > z->c) { z->c = z->l - v_15; goto lab14; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                            lab14:
                                ;
                            }
                            break;
                        case 9:
                            if (i_pV > z->c) goto lab10;
                            if (z->c <= z->lb || z->p[z->c - 1] != 'e') goto lab10;
                            z->c--;
                            {
                                int ret = slice_from_s(z, 2, s_7);
                                if (ret < 0) return ret;
                            }
                            break;
                    }
                    break;
                lab10:
                    z->c = z->l - v_11;
                    {
                        int v_16;
                        if (z->c < i_pV) goto lab9;
                        v_16 = z->lb; z->lb = i_pV;
                        z->ket = z->c;
                        if (!find_among_b(z, a_6, 120, 0)) { z->lb = v_16; goto lab9; }
                        z->bra = z->c;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        z->lb = v_16;
                    }
                } while (0);
                z->c = z->l - v_10;
                {
                    int v_17 = z->l - z->c;
                    z->ket = z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'i') goto lab15;
                    z->c--;
                    z->bra = z->c;
                    {
                        int v_18 = z->l - z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] != 'c') goto lab15;
                        z->c--;
                        z->c = z->l - v_18;
                    }
                    if (i_pV > z->c) goto lab15;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                lab15:
                    z->c = z->l - v_17;
                }
            }
            break;
        lab9:
            z->c = z->l - v_9;
            z->ket = z->c;
            if (!find_among_b(z, a_7, 7, 0)) goto lab8;
            z->bra = z->c;
            if (i_pV > z->c) goto lab8;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        } while (0);
    lab8:
        z->c = z->l - v_8;
    }
    {
        int v_19 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_8, 4, 0);
        if (!among_var) goto lab16;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                if (i_pV > z->c) goto lab16;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                z->ket = z->c;
                do {
                    int v_20 = z->l - z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'u') goto lab17;
                    z->c--;
                    z->bra = z->c;
                    {
                        int v_21 = z->l - z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] != 'g') goto lab17;
                        z->c--;
                        z->c = z->l - v_21;
                    }
                    break;
                lab17:
                    z->c = z->l - v_20;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'i') goto lab16;
                    z->c--;
                    z->bra = z->c;
                    {
                        int v_22 = z->l - z->c;
                        if (z->c <= z->lb || z->p[z->c - 1] != 'c') goto lab16;
                        z->c--;
                        z->c = z->l - v_22;
                    }
                } while (0);
                if (i_pV > z->c) goto lab16;
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
        }
    lab16:
        z->c = z->l - v_19;
    }
    z->c = z->lb;
    {
        int v_23 = z->c;
        while (1) {
            int v_24 = z->c;
            z->bra = z->c;
            if (z->c + 1 >= z->l || z->p[z->c + 1] != 126) among_var = 3; else
            among_var = find_among(z, a_1, 3, 0);
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 1, s_9);
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
                    if (z->c >= z->l) goto lab19;
                    z->c++;
                    break;
            }
            continue;
        lab19:
            z->c = v_24;
            break;
        }
        z->c = v_23;
    }
    return 1;
}

extern struct SN_env * portuguese_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
