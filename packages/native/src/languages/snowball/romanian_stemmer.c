/*
 * Generated from algorithms/romanian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "romanian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int romanian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 0x219 };
static const symbol s_1[] = { 0x21B };
static const symbol s_2[] = { 'U' };
static const symbol s_3[] = { 'I' };
static const symbol s_4[] = { 'a' };
static const symbol s_5[] = { 'e' };
static const symbol s_6[] = { 'i' };
static const symbol s_7[] = { 'a', 'b' };
static const symbol s_8[] = { 'i' };
static const symbol s_9[] = { 'a', 't' };
static const symbol s_10[] = { 'a', 0x21B, 'i' };
static const symbol s_11[] = { 'a', 'b', 'i', 'l' };
static const symbol s_12[] = { 'i', 'b', 'i', 'l' };
static const symbol s_13[] = { 'i', 'v' };
static const symbol s_14[] = { 'i', 'c' };
static const symbol s_15[] = { 'a', 't' };
static const symbol s_16[] = { 'i', 't' };
static const symbol s_17[] = { 't' };
static const symbol s_18[] = { 'i', 's', 't' };
static const symbol s_19[] = { 'i' };
static const symbol s_20[] = { 'u' };

static const symbol s_0_0[1] = { 0x15F };
static const symbol s_0_1[1] = { 0x163 };
static const struct among a_0[2] = {
{ 1, s_0_0, 0, 1, 0},
{ 1, s_0_1, 0, 2, 0}
};

static const symbol s_1_1[1] = { 'I' };
static const symbol s_1_2[1] = { 'U' };
static const struct among a_1[3] = {
{ 0, 0, 0, 3, 0},
{ 1, s_1_1, -1, 1, 0},
{ 1, s_1_2, -2, 2, 0}
};

static const symbol s_2_0[2] = { 'e', 'a' };
static const symbol s_2_1[4] = { 'a', 0x21B, 'i', 'a' };
static const symbol s_2_2[3] = { 'a', 'u', 'a' };
static const symbol s_2_3[3] = { 'i', 'u', 'a' };
static const symbol s_2_4[4] = { 'a', 0x21B, 'i', 'e' };
static const symbol s_2_5[3] = { 'e', 'l', 'e' };
static const symbol s_2_6[3] = { 'i', 'l', 'e' };
static const symbol s_2_7[4] = { 'i', 'i', 'l', 'e' };
static const symbol s_2_8[3] = { 'i', 'e', 'i' };
static const symbol s_2_9[4] = { 'a', 't', 'e', 'i' };
static const symbol s_2_10[2] = { 'i', 'i' };
static const symbol s_2_11[4] = { 'u', 'l', 'u', 'i' };
static const symbol s_2_12[2] = { 'u', 'l' };
static const symbol s_2_13[4] = { 'e', 'l', 'o', 'r' };
static const symbol s_2_14[4] = { 'i', 'l', 'o', 'r' };
static const symbol s_2_15[5] = { 'i', 'i', 'l', 'o', 'r' };
static const struct among a_2[16] = {
{ 2, s_2_0, 0, 3, 0},
{ 4, s_2_1, 0, 7, 0},
{ 3, s_2_2, 0, 2, 0},
{ 3, s_2_3, 0, 4, 0},
{ 4, s_2_4, 0, 7, 0},
{ 3, s_2_5, 0, 3, 0},
{ 3, s_2_6, 0, 5, 0},
{ 4, s_2_7, -1, 4, 0},
{ 3, s_2_8, 0, 4, 0},
{ 4, s_2_9, 0, 6, 0},
{ 2, s_2_10, 0, 4, 0},
{ 4, s_2_11, 0, 1, 0},
{ 2, s_2_12, 0, 1, 0},
{ 4, s_2_13, 0, 3, 0},
{ 4, s_2_14, 0, 4, 0},
{ 5, s_2_15, -1, 4, 0}
};

static const symbol s_3_0[5] = { 'i', 'c', 'a', 'l', 'a' };
static const symbol s_3_1[5] = { 'i', 'c', 'i', 'v', 'a' };
static const symbol s_3_2[5] = { 'a', 't', 'i', 'v', 'a' };
static const symbol s_3_3[5] = { 'i', 't', 'i', 'v', 'a' };
static const symbol s_3_4[5] = { 'i', 'c', 'a', 'l', 'e' };
static const symbol s_3_5[6] = { 'a', 0x21B, 'i', 'u', 'n', 'e' };
static const symbol s_3_6[6] = { 'i', 0x21B, 'i', 'u', 'n', 'e' };
static const symbol s_3_7[6] = { 'a', 't', 'o', 'a', 'r', 'e' };
static const symbol s_3_8[6] = { 'i', 't', 'o', 'a', 'r', 'e' };
static const symbol s_3_9[6] = { 0x103, 't', 'o', 'a', 'r', 'e' };
static const symbol s_3_10[7] = { 'i', 'c', 'i', 't', 'a', 't', 'e' };
static const symbol s_3_11[9] = { 'a', 'b', 'i', 'l', 'i', 't', 'a', 't', 'e' };
static const symbol s_3_12[9] = { 'i', 'b', 'i', 'l', 'i', 't', 'a', 't', 'e' };
static const symbol s_3_13[7] = { 'i', 'v', 'i', 't', 'a', 't', 'e' };
static const symbol s_3_14[5] = { 'i', 'c', 'i', 'v', 'e' };
static const symbol s_3_15[5] = { 'a', 't', 'i', 'v', 'e' };
static const symbol s_3_16[5] = { 'i', 't', 'i', 'v', 'e' };
static const symbol s_3_17[5] = { 'i', 'c', 'a', 'l', 'i' };
static const symbol s_3_18[5] = { 'a', 't', 'o', 'r', 'i' };
static const symbol s_3_19[7] = { 'i', 'c', 'a', 't', 'o', 'r', 'i' };
static const symbol s_3_20[5] = { 'i', 't', 'o', 'r', 'i' };
static const symbol s_3_21[5] = { 0x103, 't', 'o', 'r', 'i' };
static const symbol s_3_22[7] = { 'i', 'c', 'i', 't', 'a', 't', 'i' };
static const symbol s_3_23[9] = { 'a', 'b', 'i', 'l', 'i', 't', 'a', 't', 'i' };
static const symbol s_3_24[7] = { 'i', 'v', 'i', 't', 'a', 't', 'i' };
static const symbol s_3_25[5] = { 'i', 'c', 'i', 'v', 'i' };
static const symbol s_3_26[5] = { 'a', 't', 'i', 'v', 'i' };
static const symbol s_3_27[5] = { 'i', 't', 'i', 'v', 'i' };
static const symbol s_3_28[6] = { 'i', 'c', 'i', 't', 0x103, 'i' };
static const symbol s_3_29[8] = { 'a', 'b', 'i', 'l', 'i', 't', 0x103, 'i' };
static const symbol s_3_30[6] = { 'i', 'v', 'i', 't', 0x103, 'i' };
static const symbol s_3_31[7] = { 'i', 'c', 'i', 't', 0x103, 0x21B, 'i' };
static const symbol s_3_32[9] = { 'a', 'b', 'i', 'l', 'i', 't', 0x103, 0x21B, 'i' };
static const symbol s_3_33[7] = { 'i', 'v', 'i', 't', 0x103, 0x21B, 'i' };
static const symbol s_3_34[4] = { 'i', 'c', 'a', 'l' };
static const symbol s_3_35[4] = { 'a', 't', 'o', 'r' };
static const symbol s_3_36[6] = { 'i', 'c', 'a', 't', 'o', 'r' };
static const symbol s_3_37[4] = { 'i', 't', 'o', 'r' };
static const symbol s_3_38[4] = { 0x103, 't', 'o', 'r' };
static const symbol s_3_39[4] = { 'i', 'c', 'i', 'v' };
static const symbol s_3_40[4] = { 'a', 't', 'i', 'v' };
static const symbol s_3_41[4] = { 'i', 't', 'i', 'v' };
static const symbol s_3_42[5] = { 'i', 'c', 'a', 'l', 0x103 };
static const symbol s_3_43[5] = { 'i', 'c', 'i', 'v', 0x103 };
static const symbol s_3_44[5] = { 'a', 't', 'i', 'v', 0x103 };
static const symbol s_3_45[5] = { 'i', 't', 'i', 'v', 0x103 };
static const struct among a_3[46] = {
{ 5, s_3_0, 0, 4, 0},
{ 5, s_3_1, 0, 4, 0},
{ 5, s_3_2, 0, 5, 0},
{ 5, s_3_3, 0, 6, 0},
{ 5, s_3_4, 0, 4, 0},
{ 6, s_3_5, 0, 5, 0},
{ 6, s_3_6, 0, 6, 0},
{ 6, s_3_7, 0, 5, 0},
{ 6, s_3_8, 0, 6, 0},
{ 6, s_3_9, 0, 5, 0},
{ 7, s_3_10, 0, 4, 0},
{ 9, s_3_11, 0, 1, 0},
{ 9, s_3_12, 0, 2, 0},
{ 7, s_3_13, 0, 3, 0},
{ 5, s_3_14, 0, 4, 0},
{ 5, s_3_15, 0, 5, 0},
{ 5, s_3_16, 0, 6, 0},
{ 5, s_3_17, 0, 4, 0},
{ 5, s_3_18, 0, 5, 0},
{ 7, s_3_19, -1, 4, 0},
{ 5, s_3_20, 0, 6, 0},
{ 5, s_3_21, 0, 5, 0},
{ 7, s_3_22, 0, 4, 0},
{ 9, s_3_23, 0, 1, 0},
{ 7, s_3_24, 0, 3, 0},
{ 5, s_3_25, 0, 4, 0},
{ 5, s_3_26, 0, 5, 0},
{ 5, s_3_27, 0, 6, 0},
{ 6, s_3_28, 0, 4, 0},
{ 8, s_3_29, 0, 1, 0},
{ 6, s_3_30, 0, 3, 0},
{ 7, s_3_31, 0, 4, 0},
{ 9, s_3_32, 0, 1, 0},
{ 7, s_3_33, 0, 3, 0},
{ 4, s_3_34, 0, 4, 0},
{ 4, s_3_35, 0, 5, 0},
{ 6, s_3_36, -1, 4, 0},
{ 4, s_3_37, 0, 6, 0},
{ 4, s_3_38, 0, 5, 0},
{ 4, s_3_39, 0, 4, 0},
{ 4, s_3_40, 0, 5, 0},
{ 4, s_3_41, 0, 6, 0},
{ 5, s_3_42, 0, 4, 0},
{ 5, s_3_43, 0, 4, 0},
{ 5, s_3_44, 0, 5, 0},
{ 5, s_3_45, 0, 6, 0}
};

static const symbol s_4_0[3] = { 'i', 'c', 'a' };
static const symbol s_4_1[5] = { 'a', 'b', 'i', 'l', 'a' };
static const symbol s_4_2[5] = { 'i', 'b', 'i', 'l', 'a' };
static const symbol s_4_3[4] = { 'o', 'a', 's', 'a' };
static const symbol s_4_4[3] = { 'a', 't', 'a' };
static const symbol s_4_5[3] = { 'i', 't', 'a' };
static const symbol s_4_6[4] = { 'a', 'n', 't', 'a' };
static const symbol s_4_7[4] = { 'i', 's', 't', 'a' };
static const symbol s_4_8[3] = { 'u', 't', 'a' };
static const symbol s_4_9[3] = { 'i', 'v', 'a' };
static const symbol s_4_10[2] = { 'i', 'c' };
static const symbol s_4_11[3] = { 'i', 'c', 'e' };
static const symbol s_4_12[5] = { 'a', 'b', 'i', 'l', 'e' };
static const symbol s_4_13[5] = { 'i', 'b', 'i', 'l', 'e' };
static const symbol s_4_14[4] = { 'i', 's', 'm', 'e' };
static const symbol s_4_15[4] = { 'i', 'u', 'n', 'e' };
static const symbol s_4_16[4] = { 'o', 'a', 's', 'e' };
static const symbol s_4_17[3] = { 'a', 't', 'e' };
static const symbol s_4_18[5] = { 'i', 't', 'a', 't', 'e' };
static const symbol s_4_19[3] = { 'i', 't', 'e' };
static const symbol s_4_20[4] = { 'a', 'n', 't', 'e' };
static const symbol s_4_21[4] = { 'i', 's', 't', 'e' };
static const symbol s_4_22[3] = { 'u', 't', 'e' };
static const symbol s_4_23[3] = { 'i', 'v', 'e' };
static const symbol s_4_24[3] = { 'i', 'c', 'i' };
static const symbol s_4_25[5] = { 'a', 'b', 'i', 'l', 'i' };
static const symbol s_4_26[5] = { 'i', 'b', 'i', 'l', 'i' };
static const symbol s_4_27[4] = { 'i', 'u', 'n', 'i' };
static const symbol s_4_28[5] = { 'a', 't', 'o', 'r', 'i' };
static const symbol s_4_29[3] = { 'o', 's', 'i' };
static const symbol s_4_30[3] = { 'a', 't', 'i' };
static const symbol s_4_31[5] = { 'i', 't', 'a', 't', 'i' };
static const symbol s_4_32[3] = { 'i', 't', 'i' };
static const symbol s_4_33[4] = { 'a', 'n', 't', 'i' };
static const symbol s_4_34[4] = { 'i', 's', 't', 'i' };
static const symbol s_4_35[3] = { 'u', 't', 'i' };
static const symbol s_4_36[4] = { 'i', 0x219, 't', 'i' };
static const symbol s_4_37[3] = { 'i', 'v', 'i' };
static const symbol s_4_38[4] = { 'i', 't', 0x103, 'i' };
static const symbol s_4_39[3] = { 'o', 0x219, 'i' };
static const symbol s_4_40[5] = { 'i', 't', 0x103, 0x21B, 'i' };
static const symbol s_4_41[4] = { 'a', 'b', 'i', 'l' };
static const symbol s_4_42[4] = { 'i', 'b', 'i', 'l' };
static const symbol s_4_43[3] = { 'i', 's', 'm' };
static const symbol s_4_44[4] = { 'a', 't', 'o', 'r' };
static const symbol s_4_45[2] = { 'o', 's' };
static const symbol s_4_46[2] = { 'a', 't' };
static const symbol s_4_47[2] = { 'i', 't' };
static const symbol s_4_48[3] = { 'a', 'n', 't' };
static const symbol s_4_49[3] = { 'i', 's', 't' };
static const symbol s_4_50[2] = { 'u', 't' };
static const symbol s_4_51[2] = { 'i', 'v' };
static const symbol s_4_52[3] = { 'i', 'c', 0x103 };
static const symbol s_4_53[5] = { 'a', 'b', 'i', 'l', 0x103 };
static const symbol s_4_54[5] = { 'i', 'b', 'i', 'l', 0x103 };
static const symbol s_4_55[4] = { 'o', 'a', 's', 0x103 };
static const symbol s_4_56[3] = { 'a', 't', 0x103 };
static const symbol s_4_57[3] = { 'i', 't', 0x103 };
static const symbol s_4_58[4] = { 'a', 'n', 't', 0x103 };
static const symbol s_4_59[4] = { 'i', 's', 't', 0x103 };
static const symbol s_4_60[3] = { 'u', 't', 0x103 };
static const symbol s_4_61[3] = { 'i', 'v', 0x103 };
static const struct among a_4[62] = {
{ 3, s_4_0, 0, 1, 0},
{ 5, s_4_1, 0, 1, 0},
{ 5, s_4_2, 0, 1, 0},
{ 4, s_4_3, 0, 1, 0},
{ 3, s_4_4, 0, 1, 0},
{ 3, s_4_5, 0, 1, 0},
{ 4, s_4_6, 0, 1, 0},
{ 4, s_4_7, 0, 3, 0},
{ 3, s_4_8, 0, 1, 0},
{ 3, s_4_9, 0, 1, 0},
{ 2, s_4_10, 0, 1, 0},
{ 3, s_4_11, 0, 1, 0},
{ 5, s_4_12, 0, 1, 0},
{ 5, s_4_13, 0, 1, 0},
{ 4, s_4_14, 0, 3, 0},
{ 4, s_4_15, 0, 2, 0},
{ 4, s_4_16, 0, 1, 0},
{ 3, s_4_17, 0, 1, 0},
{ 5, s_4_18, -1, 1, 0},
{ 3, s_4_19, 0, 1, 0},
{ 4, s_4_20, 0, 1, 0},
{ 4, s_4_21, 0, 3, 0},
{ 3, s_4_22, 0, 1, 0},
{ 3, s_4_23, 0, 1, 0},
{ 3, s_4_24, 0, 1, 0},
{ 5, s_4_25, 0, 1, 0},
{ 5, s_4_26, 0, 1, 0},
{ 4, s_4_27, 0, 2, 0},
{ 5, s_4_28, 0, 1, 0},
{ 3, s_4_29, 0, 1, 0},
{ 3, s_4_30, 0, 1, 0},
{ 5, s_4_31, -1, 1, 0},
{ 3, s_4_32, 0, 1, 0},
{ 4, s_4_33, 0, 1, 0},
{ 4, s_4_34, 0, 3, 0},
{ 3, s_4_35, 0, 1, 0},
{ 4, s_4_36, 0, 3, 0},
{ 3, s_4_37, 0, 1, 0},
{ 4, s_4_38, 0, 1, 0},
{ 3, s_4_39, 0, 1, 0},
{ 5, s_4_40, 0, 1, 0},
{ 4, s_4_41, 0, 1, 0},
{ 4, s_4_42, 0, 1, 0},
{ 3, s_4_43, 0, 3, 0},
{ 4, s_4_44, 0, 1, 0},
{ 2, s_4_45, 0, 1, 0},
{ 2, s_4_46, 0, 1, 0},
{ 2, s_4_47, 0, 1, 0},
{ 3, s_4_48, 0, 1, 0},
{ 3, s_4_49, 0, 3, 0},
{ 2, s_4_50, 0, 1, 0},
{ 2, s_4_51, 0, 1, 0},
{ 3, s_4_52, 0, 1, 0},
{ 5, s_4_53, 0, 1, 0},
{ 5, s_4_54, 0, 1, 0},
{ 4, s_4_55, 0, 1, 0},
{ 3, s_4_56, 0, 1, 0},
{ 3, s_4_57, 0, 1, 0},
{ 4, s_4_58, 0, 1, 0},
{ 4, s_4_59, 0, 3, 0},
{ 3, s_4_60, 0, 1, 0},
{ 3, s_4_61, 0, 1, 0}
};

static const symbol s_5_0[2] = { 'e', 'a' };
static const symbol s_5_1[2] = { 'i', 'a' };
static const symbol s_5_2[3] = { 'e', 's', 'c' };
static const symbol s_5_3[3] = { 0x103, 's', 'c' };
static const symbol s_5_4[3] = { 'i', 'n', 'd' };
static const symbol s_5_5[3] = { 0xE2, 'n', 'd' };
static const symbol s_5_6[3] = { 'a', 'r', 'e' };
static const symbol s_5_7[3] = { 'e', 'r', 'e' };
static const symbol s_5_8[3] = { 'i', 'r', 'e' };
static const symbol s_5_9[3] = { 0xE2, 'r', 'e' };
static const symbol s_5_10[2] = { 's', 'e' };
static const symbol s_5_11[3] = { 'a', 's', 'e' };
static const symbol s_5_12[4] = { 's', 'e', 's', 'e' };
static const symbol s_5_13[3] = { 'i', 's', 'e' };
static const symbol s_5_14[3] = { 'u', 's', 'e' };
static const symbol s_5_15[3] = { 0xE2, 's', 'e' };
static const symbol s_5_16[4] = { 'e', 0x219, 't', 'e' };
static const symbol s_5_17[4] = { 0x103, 0x219, 't', 'e' };
static const symbol s_5_18[3] = { 'e', 'z', 'e' };
static const symbol s_5_19[2] = { 'a', 'i' };
static const symbol s_5_20[3] = { 'e', 'a', 'i' };
static const symbol s_5_21[3] = { 'i', 'a', 'i' };
static const symbol s_5_22[3] = { 's', 'e', 'i' };
static const symbol s_5_23[4] = { 'e', 0x219, 't', 'i' };
static const symbol s_5_24[4] = { 0x103, 0x219, 't', 'i' };
static const symbol s_5_25[2] = { 'u', 'i' };
static const symbol s_5_26[3] = { 'e', 'z', 'i' };
static const symbol s_5_27[2] = { 0xE2, 'i' };
static const symbol s_5_28[3] = { 'a', 0x219, 'i' };
static const symbol s_5_29[4] = { 's', 'e', 0x219, 'i' };
static const symbol s_5_30[5] = { 'a', 's', 'e', 0x219, 'i' };
static const symbol s_5_31[6] = { 's', 'e', 's', 'e', 0x219, 'i' };
static const symbol s_5_32[5] = { 'i', 's', 'e', 0x219, 'i' };
static const symbol s_5_33[5] = { 'u', 's', 'e', 0x219, 'i' };
static const symbol s_5_34[5] = { 0xE2, 's', 'e', 0x219, 'i' };
static const symbol s_5_35[3] = { 'i', 0x219, 'i' };
static const symbol s_5_36[3] = { 'u', 0x219, 'i' };
static const symbol s_5_37[3] = { 0xE2, 0x219, 'i' };
static const symbol s_5_38[3] = { 'a', 0x21B, 'i' };
static const symbol s_5_39[4] = { 'e', 'a', 0x21B, 'i' };
static const symbol s_5_40[4] = { 'i', 'a', 0x21B, 'i' };
static const symbol s_5_41[3] = { 'e', 0x21B, 'i' };
static const symbol s_5_42[3] = { 'i', 0x21B, 'i' };
static const symbol s_5_43[3] = { 0xE2, 0x21B, 'i' };
static const symbol s_5_44[5] = { 'a', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_45[6] = { 's', 'e', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_46[7] = { 'a', 's', 'e', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_47[8] = { 's', 'e', 's', 'e', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_48[7] = { 'i', 's', 'e', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_49[7] = { 'u', 's', 'e', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_50[7] = { 0xE2, 's', 'e', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_51[5] = { 'i', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_52[5] = { 'u', 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_53[5] = { 0xE2, 'r', 0x103, 0x21B, 'i' };
static const symbol s_5_54[2] = { 'a', 'm' };
static const symbol s_5_55[3] = { 'e', 'a', 'm' };
static const symbol s_5_56[3] = { 'i', 'a', 'm' };
static const symbol s_5_57[2] = { 'e', 'm' };
static const symbol s_5_58[4] = { 'a', 's', 'e', 'm' };
static const symbol s_5_59[5] = { 's', 'e', 's', 'e', 'm' };
static const symbol s_5_60[4] = { 'i', 's', 'e', 'm' };
static const symbol s_5_61[4] = { 'u', 's', 'e', 'm' };
static const symbol s_5_62[4] = { 0xE2, 's', 'e', 'm' };
static const symbol s_5_63[2] = { 'i', 'm' };
static const symbol s_5_64[2] = { 0xE2, 'm' };
static const symbol s_5_65[2] = { 0x103, 'm' };
static const symbol s_5_66[4] = { 'a', 'r', 0x103, 'm' };
static const symbol s_5_67[5] = { 's', 'e', 'r', 0x103, 'm' };
static const symbol s_5_68[6] = { 'a', 's', 'e', 'r', 0x103, 'm' };
static const symbol s_5_69[7] = { 's', 'e', 's', 'e', 'r', 0x103, 'm' };
static const symbol s_5_70[6] = { 'i', 's', 'e', 'r', 0x103, 'm' };
static const symbol s_5_71[6] = { 'u', 's', 'e', 'r', 0x103, 'm' };
static const symbol s_5_72[6] = { 0xE2, 's', 'e', 'r', 0x103, 'm' };
static const symbol s_5_73[4] = { 'i', 'r', 0x103, 'm' };
static const symbol s_5_74[4] = { 'u', 'r', 0x103, 'm' };
static const symbol s_5_75[4] = { 0xE2, 'r', 0x103, 'm' };
static const symbol s_5_76[2] = { 'a', 'u' };
static const symbol s_5_77[3] = { 'e', 'a', 'u' };
static const symbol s_5_78[3] = { 'i', 'a', 'u' };
static const symbol s_5_79[4] = { 'i', 'n', 'd', 'u' };
static const symbol s_5_80[4] = { 0xE2, 'n', 'd', 'u' };
static const symbol s_5_81[2] = { 'e', 'z' };
static const symbol s_5_82[5] = { 'e', 'a', 's', 'c', 0x103 };
static const symbol s_5_83[3] = { 'a', 'r', 0x103 };
static const symbol s_5_84[4] = { 's', 'e', 'r', 0x103 };
static const symbol s_5_85[5] = { 'a', 's', 'e', 'r', 0x103 };
static const symbol s_5_86[6] = { 's', 'e', 's', 'e', 'r', 0x103 };
static const symbol s_5_87[5] = { 'i', 's', 'e', 'r', 0x103 };
static const symbol s_5_88[5] = { 'u', 's', 'e', 'r', 0x103 };
static const symbol s_5_89[5] = { 0xE2, 's', 'e', 'r', 0x103 };
static const symbol s_5_90[3] = { 'i', 'r', 0x103 };
static const symbol s_5_91[3] = { 'u', 'r', 0x103 };
static const symbol s_5_92[3] = { 0xE2, 'r', 0x103 };
static const symbol s_5_93[4] = { 'e', 'a', 'z', 0x103 };
static const struct among a_5[94] = {
{ 2, s_5_0, 0, 1, 0},
{ 2, s_5_1, 0, 1, 0},
{ 3, s_5_2, 0, 1, 0},
{ 3, s_5_3, 0, 1, 0},
{ 3, s_5_4, 0, 1, 0},
{ 3, s_5_5, 0, 1, 0},
{ 3, s_5_6, 0, 1, 0},
{ 3, s_5_7, 0, 1, 0},
{ 3, s_5_8, 0, 1, 0},
{ 3, s_5_9, 0, 1, 0},
{ 2, s_5_10, 0, 2, 0},
{ 3, s_5_11, -1, 1, 0},
{ 4, s_5_12, -2, 2, 0},
{ 3, s_5_13, -3, 1, 0},
{ 3, s_5_14, -4, 1, 0},
{ 3, s_5_15, -5, 1, 0},
{ 4, s_5_16, 0, 1, 0},
{ 4, s_5_17, 0, 1, 0},
{ 3, s_5_18, 0, 1, 0},
{ 2, s_5_19, 0, 1, 0},
{ 3, s_5_20, -1, 1, 0},
{ 3, s_5_21, -2, 1, 0},
{ 3, s_5_22, 0, 2, 0},
{ 4, s_5_23, 0, 1, 0},
{ 4, s_5_24, 0, 1, 0},
{ 2, s_5_25, 0, 1, 0},
{ 3, s_5_26, 0, 1, 0},
{ 2, s_5_27, 0, 1, 0},
{ 3, s_5_28, 0, 1, 0},
{ 4, s_5_29, 0, 2, 0},
{ 5, s_5_30, -1, 1, 0},
{ 6, s_5_31, -2, 2, 0},
{ 5, s_5_32, -3, 1, 0},
{ 5, s_5_33, -4, 1, 0},
{ 5, s_5_34, -5, 1, 0},
{ 3, s_5_35, 0, 1, 0},
{ 3, s_5_36, 0, 1, 0},
{ 3, s_5_37, 0, 1, 0},
{ 3, s_5_38, 0, 2, 0},
{ 4, s_5_39, -1, 1, 0},
{ 4, s_5_40, -2, 1, 0},
{ 3, s_5_41, 0, 2, 0},
{ 3, s_5_42, 0, 2, 0},
{ 3, s_5_43, 0, 2, 0},
{ 5, s_5_44, 0, 1, 0},
{ 6, s_5_45, 0, 2, 0},
{ 7, s_5_46, -1, 1, 0},
{ 8, s_5_47, -2, 2, 0},
{ 7, s_5_48, -3, 1, 0},
{ 7, s_5_49, -4, 1, 0},
{ 7, s_5_50, -5, 1, 0},
{ 5, s_5_51, 0, 1, 0},
{ 5, s_5_52, 0, 1, 0},
{ 5, s_5_53, 0, 1, 0},
{ 2, s_5_54, 0, 1, 0},
{ 3, s_5_55, -1, 1, 0},
{ 3, s_5_56, -2, 1, 0},
{ 2, s_5_57, 0, 2, 0},
{ 4, s_5_58, -1, 1, 0},
{ 5, s_5_59, -2, 2, 0},
{ 4, s_5_60, -3, 1, 0},
{ 4, s_5_61, -4, 1, 0},
{ 4, s_5_62, -5, 1, 0},
{ 2, s_5_63, 0, 2, 0},
{ 2, s_5_64, 0, 2, 0},
{ 2, s_5_65, 0, 2, 0},
{ 4, s_5_66, -1, 1, 0},
{ 5, s_5_67, -2, 2, 0},
{ 6, s_5_68, -1, 1, 0},
{ 7, s_5_69, -2, 2, 0},
{ 6, s_5_70, -3, 1, 0},
{ 6, s_5_71, -4, 1, 0},
{ 6, s_5_72, -5, 1, 0},
{ 4, s_5_73, -8, 1, 0},
{ 4, s_5_74, -9, 1, 0},
{ 4, s_5_75, -10, 1, 0},
{ 2, s_5_76, 0, 1, 0},
{ 3, s_5_77, -1, 1, 0},
{ 3, s_5_78, -2, 1, 0},
{ 4, s_5_79, 0, 1, 0},
{ 4, s_5_80, 0, 1, 0},
{ 2, s_5_81, 0, 1, 0},
{ 5, s_5_82, 0, 1, 0},
{ 3, s_5_83, 0, 1, 0},
{ 4, s_5_84, 0, 2, 0},
{ 5, s_5_85, -1, 1, 0},
{ 6, s_5_86, -2, 2, 0},
{ 5, s_5_87, -3, 1, 0},
{ 5, s_5_88, -4, 1, 0},
{ 5, s_5_89, -5, 1, 0},
{ 3, s_5_90, 0, 1, 0},
{ 3, s_5_91, 0, 1, 0},
{ 3, s_5_92, 0, 1, 0},
{ 4, s_5_93, 0, 1, 0}
};

static const symbol s_6_0[1] = { 'a' };
static const symbol s_6_1[1] = { 'e' };
static const symbol s_6_2[2] = { 'i', 'e' };
static const symbol s_6_3[1] = { 'i' };
static const symbol s_6_4[1] = { 0x103 };
static const struct among a_6[5] = {
{ 1, s_6_0, 0, 1, 0},
{ 1, s_6_1, 0, 1, 0},
{ 2, s_6_2, -1, 1, 0},
{ 1, s_6_3, 0, 1, 0},
{ 1, s_6_4, 0, 1, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 32, 0, 0, 4 };

extern int romanian_stem(struct SN_env * z) {
    int among_var;
    int b_standard_suffix_removed;
    int i_p2;
    int i_p1;
    int i_pV;
    {
        int v_1 = z->c;
        while (1) {
            int v_2 = z->c;
            while (1) {
                int v_3 = z->c;
                z->bra = z->c;
                if (z->c >= z->l || (z->p[z->c + 0] != 351 && z->p[z->c + 0] != 355)) goto lab3;
                among_var = find_among(z, a_0, 2, 0);
                if (!among_var) goto lab3;
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
                }
                z->c = v_3;
                break;
            lab3:
                z->c = v_3;
                if (z->c >= z->l) goto lab2;
                z->c++;
            }
            continue;
        lab2:
            z->c = v_2;
            break;
        }
        z->c = v_1;
    }
    {
        int v_4 = z->c;
        while (1) {
            int v_5 = z->c;
            while (1) {
                int v_6 = z->c;
                if (in_grouping(z, g_v, 97, 259, 0)) goto lab6;
                z->bra = z->c;
                do {
                    int v_7 = z->c;
                    if (z->c == z->l || z->p[z->c] != 'u') goto lab7;
                    z->c++;
                    z->ket = z->c;
                    if (in_grouping(z, g_v, 97, 259, 0)) goto lab7;
                    {
                        int ret = slice_from_s(z, 1, s_2);
                        if (ret < 0) return ret;
                    }
                    break;
                lab7:
                    z->c = v_7;
                    if (z->c == z->l || z->p[z->c] != 'i') goto lab6;
                    z->c++;
                    z->ket = z->c;
                    if (in_grouping(z, g_v, 97, 259, 0)) goto lab6;
                    {
                        int ret = slice_from_s(z, 1, s_3);
                        if (ret < 0) return ret;
                    }
                } while (0);
                z->c = v_6;
                break;
            lab6:
                z->c = v_6;
                if (z->c >= z->l) goto lab5;
                z->c++;
            }
            continue;
        lab5:
            z->c = v_5;
            break;
        }
        z->c = v_4;
    }
    i_pV = z->l;
    i_p1 = z->l;
    i_p2 = z->l;
    {
        int v_8 = z->c;
        do {
            int v_9 = z->c;
            if (in_grouping(z, g_v, 97, 259, 0)) goto lab10;
            do {
                int v_10 = z->c;
                if (out_grouping(z, g_v, 97, 259, 0)) goto lab11;
                {
                    int ret = out_grouping(z, g_v, 97, 259, 1);
                    if (ret < 0) goto lab11;
                    z->c += ret;
                }
                break;
            lab11:
                z->c = v_10;
                if (in_grouping(z, g_v, 97, 259, 0)) goto lab10;
                {
                    int ret = in_grouping(z, g_v, 97, 259, 1);
                    if (ret < 0) goto lab10;
                    z->c += ret;
                }
            } while (0);
            break;
        lab10:
            z->c = v_9;
            if (out_grouping(z, g_v, 97, 259, 0)) goto lab9;
            do {
                int v_11 = z->c;
                if (out_grouping(z, g_v, 97, 259, 0)) goto lab12;
                {
                    int ret = out_grouping(z, g_v, 97, 259, 1);
                    if (ret < 0) goto lab12;
                    z->c += ret;
                }
                break;
            lab12:
                z->c = v_11;
                if (in_grouping(z, g_v, 97, 259, 0)) goto lab9;
                if (z->c >= z->l) goto lab9;
                z->c++;
            } while (0);
        } while (0);
        i_pV = z->c;
    lab9:
        z->c = v_8;
    }
    {
        int v_12 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 259, 1);
            if (ret < 0) goto lab13;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 259, 1);
            if (ret < 0) goto lab13;
            z->c += ret;
        }
        i_p1 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 259, 1);
            if (ret < 0) goto lab13;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 259, 1);
            if (ret < 0) goto lab13;
            z->c += ret;
        }
        i_p2 = z->c;
    lab13:
        z->c = v_12;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_13 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((266786 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab14;
        among_var = find_among_b(z, a_2, 16, 0);
        if (!among_var) goto lab14;
        z->bra = z->c;
        if (i_p1 > z->c) goto lab14;
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
            case 4:
                {
                    int ret = slice_from_s(z, 1, s_6);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                if (!(eq_s_b(z, 2, s_7))) goto lab15;
                goto lab14;
            lab15:
                {
                    int ret = slice_from_s(z, 1, s_8);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                {
                    int ret = slice_from_s(z, 2, s_9);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                {
                    int ret = slice_from_s(z, 3, s_10);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab14:
        z->c = z->l - v_13;
    }
    {
        int v_14 = z->l - z->c;
        b_standard_suffix_removed = 0;
        while (1) {
            int v_15 = z->l - z->c;
            {
                int v_16 = z->l - z->c;
                z->ket = z->c;
                among_var = find_among_b(z, a_3, 46, 0);
                if (!among_var) goto lab17;
                z->bra = z->c;
                if (i_p1 > z->c) goto lab17;
                switch (among_var) {
                    case 1:
                        {
                            int ret = slice_from_s(z, 4, s_11);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 2:
                        {
                            int ret = slice_from_s(z, 4, s_12);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 3:
                        {
                            int ret = slice_from_s(z, 2, s_13);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 4:
                        {
                            int ret = slice_from_s(z, 2, s_14);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 5:
                        {
                            int ret = slice_from_s(z, 2, s_15);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 6:
                        {
                            int ret = slice_from_s(z, 2, s_16);
                            if (ret < 0) return ret;
                        }
                        break;
                }
                b_standard_suffix_removed = 1;
                z->c = z->l - v_16;
            }
            continue;
        lab17:
            z->c = z->l - v_15;
            break;
        }
        z->ket = z->c;
        among_var = find_among_b(z, a_4, 62, 0);
        if (!among_var) goto lab16;
        z->bra = z->c;
        if (i_p2 > z->c) goto lab16;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                if (z->c <= z->lb || z->p[z->c - 1] != 0x21B) goto lab16;
                z->c--;
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 1, s_17);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 3, s_18);
                    if (ret < 0) return ret;
                }
                break;
        }
        b_standard_suffix_removed = 1;
    lab16:
        z->c = z->l - v_14;
    }
    {
        int v_17 = z->l - z->c;
        do {
            if (!b_standard_suffix_removed) goto lab19;
            break;
        lab19:
            {
                int v_18;
                if (z->c < i_pV) goto lab18;
                v_18 = z->lb; z->lb = i_pV;
                z->ket = z->c;
                among_var = find_among_b(z, a_5, 94, 0);
                if (!among_var) { z->lb = v_18; goto lab18; }
                z->bra = z->c;
                switch (among_var) {
                    case 1:
                        do {
                            if (out_grouping_b(z, g_v, 97, 259, 0)) goto lab20;
                            break;
                        lab20:
                            if (z->c <= z->lb || z->p[z->c - 1] != 'u') { z->lb = v_18; goto lab18; }
                            z->c--;
                        } while (0);
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
                z->lb = v_18;
            }
        } while (0);
    lab18:
        z->c = z->l - v_17;
    }
    {
        int v_19 = z->l - z->c;
        z->ket = z->c;
        if (!find_among_b(z, a_6, 5, 0)) goto lab21;
        z->bra = z->c;
        if (i_pV > z->c) goto lab21;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab21:
        z->c = z->l - v_19;
    }
    z->c = z->lb;
    {
        int v_20 = z->c;
        while (1) {
            int v_21 = z->c;
            z->bra = z->c;
            if (z->c >= z->l || (z->p[z->c + 0] != 73 && z->p[z->c + 0] != 85)) among_var = 3; else
            among_var = find_among(z, a_1, 3, 0);
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 1, s_19);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 1, s_20);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    if (z->c >= z->l) goto lab23;
                    z->c++;
                    break;
            }
            continue;
        lab23:
            z->c = v_21;
            break;
        }
        z->c = v_20;
    }
    return 1;
}

extern struct SN_env * romanian_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
