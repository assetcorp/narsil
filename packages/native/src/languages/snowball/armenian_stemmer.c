/*
 * Generated from algorithms/armenian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "armenian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int armenian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif


static const symbol s_0_0[4] = { 0x580, 0x578, 0x580, 0x564 };
static const symbol s_0_1[5] = { 0x565, 0x580, 0x578, 0x580, 0x564 };
static const symbol s_0_2[3] = { 0x561, 0x56C, 0x56B };
static const symbol s_0_3[3] = { 0x561, 0x56F, 0x56B };
static const symbol s_0_4[4] = { 0x578, 0x580, 0x561, 0x56F };
static const symbol s_0_5[2] = { 0x565, 0x572 };
static const symbol s_0_6[4] = { 0x561, 0x56F, 0x561, 0x576 };
static const symbol s_0_7[4] = { 0x561, 0x580, 0x561, 0x576 };
static const symbol s_0_8[2] = { 0x565, 0x576 };
static const symbol s_0_9[4] = { 0x565, 0x56F, 0x565, 0x576 };
static const symbol s_0_10[4] = { 0x565, 0x580, 0x565, 0x576 };
static const symbol s_0_11[4] = { 0x578, 0x580, 0x567, 0x576 };
static const symbol s_0_12[2] = { 0x56B, 0x576 };
static const symbol s_0_13[3] = { 0x563, 0x56B, 0x576 };
static const symbol s_0_14[4] = { 0x578, 0x57E, 0x56B, 0x576 };
static const symbol s_0_15[4] = { 0x56C, 0x561, 0x575, 0x576 };
static const symbol s_0_16[4] = { 0x57E, 0x578, 0x582, 0x576 };
static const symbol s_0_17[3] = { 0x57A, 0x565, 0x57D };
static const symbol s_0_18[2] = { 0x56B, 0x57E };
static const symbol s_0_19[2] = { 0x561, 0x57F };
static const symbol s_0_20[4] = { 0x561, 0x57E, 0x565, 0x57F };
static const symbol s_0_21[3] = { 0x56F, 0x578, 0x57F };
static const symbol s_0_22[3] = { 0x562, 0x561, 0x580 };
static const struct among a_0[23] = {
{ 4, s_0_0, 0, 1, 0},
{ 5, s_0_1, -1, 1, 0},
{ 3, s_0_2, 0, 1, 0},
{ 3, s_0_3, 0, 1, 0},
{ 4, s_0_4, 0, 1, 0},
{ 2, s_0_5, 0, 1, 0},
{ 4, s_0_6, 0, 1, 0},
{ 4, s_0_7, 0, 1, 0},
{ 2, s_0_8, 0, 1, 0},
{ 4, s_0_9, -1, 1, 0},
{ 4, s_0_10, -2, 1, 0},
{ 4, s_0_11, 0, 1, 0},
{ 2, s_0_12, 0, 1, 0},
{ 3, s_0_13, -1, 1, 0},
{ 4, s_0_14, -2, 1, 0},
{ 4, s_0_15, 0, 1, 0},
{ 4, s_0_16, 0, 1, 0},
{ 3, s_0_17, 0, 1, 0},
{ 2, s_0_18, 0, 1, 0},
{ 2, s_0_19, 0, 1, 0},
{ 4, s_0_20, 0, 1, 0},
{ 3, s_0_21, 0, 1, 0},
{ 3, s_0_22, 0, 1, 0}
};

static const symbol s_1_0[1] = { 0x561 };
static const symbol s_1_1[3] = { 0x561, 0x581, 0x561 };
static const symbol s_1_2[3] = { 0x565, 0x581, 0x561 };
static const symbol s_1_3[2] = { 0x57E, 0x565 };
static const symbol s_1_4[4] = { 0x561, 0x581, 0x580, 0x56B };
static const symbol s_1_5[3] = { 0x561, 0x581, 0x56B };
static const symbol s_1_6[3] = { 0x565, 0x581, 0x56B };
static const symbol s_1_7[4] = { 0x57E, 0x565, 0x581, 0x56B };
static const symbol s_1_8[2] = { 0x561, 0x56C };
static const symbol s_1_9[3] = { 0x568, 0x561, 0x56C };
static const symbol s_1_10[4] = { 0x561, 0x576, 0x561, 0x56C };
static const symbol s_1_11[4] = { 0x565, 0x576, 0x561, 0x56C };
static const symbol s_1_12[5] = { 0x561, 0x581, 0x576, 0x561, 0x56C };
static const symbol s_1_13[2] = { 0x565, 0x56C };
static const symbol s_1_14[3] = { 0x568, 0x565, 0x56C };
static const symbol s_1_15[3] = { 0x576, 0x565, 0x56C };
static const symbol s_1_16[4] = { 0x581, 0x576, 0x565, 0x56C };
static const symbol s_1_17[5] = { 0x565, 0x581, 0x576, 0x565, 0x56C };
static const symbol s_1_18[3] = { 0x579, 0x565, 0x56C };
static const symbol s_1_19[3] = { 0x57E, 0x565, 0x56C };
static const symbol s_1_20[5] = { 0x561, 0x581, 0x57E, 0x565, 0x56C };
static const symbol s_1_21[5] = { 0x565, 0x581, 0x57E, 0x565, 0x56C };
static const symbol s_1_22[3] = { 0x57F, 0x565, 0x56C };
static const symbol s_1_23[4] = { 0x561, 0x57F, 0x565, 0x56C };
static const symbol s_1_24[4] = { 0x578, 0x57F, 0x565, 0x56C };
static const symbol s_1_25[5] = { 0x56F, 0x578, 0x57F, 0x565, 0x56C };
static const symbol s_1_26[3] = { 0x57E, 0x561, 0x56E };
static const symbol s_1_27[3] = { 0x578, 0x582, 0x574 };
static const symbol s_1_28[4] = { 0x57E, 0x578, 0x582, 0x574 };
static const symbol s_1_29[2] = { 0x561, 0x576 };
static const symbol s_1_30[3] = { 0x581, 0x561, 0x576 };
static const symbol s_1_31[4] = { 0x561, 0x581, 0x561, 0x576 };
static const symbol s_1_32[5] = { 0x561, 0x581, 0x580, 0x56B, 0x576 };
static const symbol s_1_33[4] = { 0x561, 0x581, 0x56B, 0x576 };
static const symbol s_1_34[4] = { 0x565, 0x581, 0x56B, 0x576 };
static const symbol s_1_35[5] = { 0x57E, 0x565, 0x581, 0x56B, 0x576 };
static const symbol s_1_36[4] = { 0x561, 0x56C, 0x56B, 0x57D };
static const symbol s_1_37[4] = { 0x565, 0x56C, 0x56B, 0x57D };
static const symbol s_1_38[2] = { 0x561, 0x57E };
static const symbol s_1_39[4] = { 0x561, 0x581, 0x561, 0x57E };
static const symbol s_1_40[4] = { 0x565, 0x581, 0x561, 0x57E };
static const symbol s_1_41[4] = { 0x561, 0x56C, 0x578, 0x57E };
static const symbol s_1_42[4] = { 0x565, 0x56C, 0x578, 0x57E };
static const symbol s_1_43[2] = { 0x561, 0x580 };
static const symbol s_1_44[4] = { 0x561, 0x581, 0x561, 0x580 };
static const symbol s_1_45[4] = { 0x565, 0x581, 0x561, 0x580 };
static const symbol s_1_46[5] = { 0x561, 0x581, 0x580, 0x56B, 0x580 };
static const symbol s_1_47[4] = { 0x561, 0x581, 0x56B, 0x580 };
static const symbol s_1_48[4] = { 0x565, 0x581, 0x56B, 0x580 };
static const symbol s_1_49[5] = { 0x57E, 0x565, 0x581, 0x56B, 0x580 };
static const symbol s_1_50[2] = { 0x561, 0x581 };
static const symbol s_1_51[2] = { 0x565, 0x581 };
static const symbol s_1_52[5] = { 0x561, 0x581, 0x580, 0x565, 0x581 };
static const symbol s_1_53[5] = { 0x561, 0x56C, 0x578, 0x582, 0x581 };
static const symbol s_1_54[5] = { 0x565, 0x56C, 0x578, 0x582, 0x581 };
static const symbol s_1_55[4] = { 0x561, 0x56C, 0x578, 0x582 };
static const symbol s_1_56[4] = { 0x565, 0x56C, 0x578, 0x582 };
static const symbol s_1_57[2] = { 0x561, 0x584 };
static const symbol s_1_58[3] = { 0x581, 0x561, 0x584 };
static const symbol s_1_59[4] = { 0x561, 0x581, 0x561, 0x584 };
static const symbol s_1_60[5] = { 0x561, 0x581, 0x580, 0x56B, 0x584 };
static const symbol s_1_61[4] = { 0x561, 0x581, 0x56B, 0x584 };
static const symbol s_1_62[4] = { 0x565, 0x581, 0x56B, 0x584 };
static const symbol s_1_63[5] = { 0x57E, 0x565, 0x581, 0x56B, 0x584 };
static const symbol s_1_64[3] = { 0x561, 0x576, 0x584 };
static const symbol s_1_65[4] = { 0x581, 0x561, 0x576, 0x584 };
static const symbol s_1_66[5] = { 0x561, 0x581, 0x561, 0x576, 0x584 };
static const symbol s_1_67[6] = { 0x561, 0x581, 0x580, 0x56B, 0x576, 0x584 };
static const symbol s_1_68[5] = { 0x561, 0x581, 0x56B, 0x576, 0x584 };
static const symbol s_1_69[5] = { 0x565, 0x581, 0x56B, 0x576, 0x584 };
static const symbol s_1_70[6] = { 0x57E, 0x565, 0x581, 0x56B, 0x576, 0x584 };
static const struct among a_1[71] = {
{ 1, s_1_0, 0, 1, 0},
{ 3, s_1_1, -1, 1, 0},
{ 3, s_1_2, -2, 1, 0},
{ 2, s_1_3, 0, 1, 0},
{ 4, s_1_4, 0, 1, 0},
{ 3, s_1_5, 0, 1, 0},
{ 3, s_1_6, 0, 1, 0},
{ 4, s_1_7, -1, 1, 0},
{ 2, s_1_8, 0, 1, 0},
{ 3, s_1_9, -1, 1, 0},
{ 4, s_1_10, -2, 1, 0},
{ 4, s_1_11, -3, 1, 0},
{ 5, s_1_12, -4, 1, 0},
{ 2, s_1_13, 0, 1, 0},
{ 3, s_1_14, -1, 1, 0},
{ 3, s_1_15, -2, 1, 0},
{ 4, s_1_16, -1, 1, 0},
{ 5, s_1_17, -1, 1, 0},
{ 3, s_1_18, -5, 1, 0},
{ 3, s_1_19, -6, 1, 0},
{ 5, s_1_20, -1, 1, 0},
{ 5, s_1_21, -2, 1, 0},
{ 3, s_1_22, -9, 1, 0},
{ 4, s_1_23, -1, 1, 0},
{ 4, s_1_24, -2, 1, 0},
{ 5, s_1_25, -1, 1, 0},
{ 3, s_1_26, 0, 1, 0},
{ 3, s_1_27, 0, 1, 0},
{ 4, s_1_28, -1, 1, 0},
{ 2, s_1_29, 0, 1, 0},
{ 3, s_1_30, -1, 1, 0},
{ 4, s_1_31, -1, 1, 0},
{ 5, s_1_32, 0, 1, 0},
{ 4, s_1_33, 0, 1, 0},
{ 4, s_1_34, 0, 1, 0},
{ 5, s_1_35, -1, 1, 0},
{ 4, s_1_36, 0, 1, 0},
{ 4, s_1_37, 0, 1, 0},
{ 2, s_1_38, 0, 1, 0},
{ 4, s_1_39, -1, 1, 0},
{ 4, s_1_40, -2, 1, 0},
{ 4, s_1_41, 0, 1, 0},
{ 4, s_1_42, 0, 1, 0},
{ 2, s_1_43, 0, 1, 0},
{ 4, s_1_44, -1, 1, 0},
{ 4, s_1_45, -2, 1, 0},
{ 5, s_1_46, 0, 1, 0},
{ 4, s_1_47, 0, 1, 0},
{ 4, s_1_48, 0, 1, 0},
{ 5, s_1_49, -1, 1, 0},
{ 2, s_1_50, 0, 1, 0},
{ 2, s_1_51, 0, 1, 0},
{ 5, s_1_52, -1, 1, 0},
{ 5, s_1_53, 0, 1, 0},
{ 5, s_1_54, 0, 1, 0},
{ 4, s_1_55, 0, 1, 0},
{ 4, s_1_56, 0, 1, 0},
{ 2, s_1_57, 0, 1, 0},
{ 3, s_1_58, -1, 1, 0},
{ 4, s_1_59, -1, 1, 0},
{ 5, s_1_60, 0, 1, 0},
{ 4, s_1_61, 0, 1, 0},
{ 4, s_1_62, 0, 1, 0},
{ 5, s_1_63, -1, 1, 0},
{ 3, s_1_64, 0, 1, 0},
{ 4, s_1_65, -1, 1, 0},
{ 5, s_1_66, -1, 1, 0},
{ 6, s_1_67, 0, 1, 0},
{ 5, s_1_68, 0, 1, 0},
{ 5, s_1_69, 0, 1, 0},
{ 6, s_1_70, -1, 1, 0}
};

static const symbol s_2_0[3] = { 0x578, 0x580, 0x564 };
static const symbol s_2_1[4] = { 0x578, 0x582, 0x575, 0x569 };
static const symbol s_2_2[4] = { 0x578, 0x582, 0x570, 0x56B };
static const symbol s_2_3[2] = { 0x581, 0x56B };
static const symbol s_2_4[2] = { 0x56B, 0x56C };
static const symbol s_2_5[2] = { 0x561, 0x56F };
static const symbol s_2_6[3] = { 0x575, 0x561, 0x56F };
static const symbol s_2_7[4] = { 0x561, 0x576, 0x561, 0x56F };
static const symbol s_2_8[2] = { 0x56B, 0x56F };
static const symbol s_2_9[3] = { 0x578, 0x582, 0x56F };
static const symbol s_2_10[2] = { 0x561, 0x576 };
static const symbol s_2_11[3] = { 0x57A, 0x561, 0x576 };
static const symbol s_2_12[4] = { 0x57D, 0x57F, 0x561, 0x576 };
static const symbol s_2_13[4] = { 0x561, 0x580, 0x561, 0x576 };
static const symbol s_2_14[4] = { 0x565, 0x572, 0x567, 0x576 };
static const symbol s_2_15[4] = { 0x575, 0x578, 0x582, 0x576 };
static const symbol s_2_16[7] = { 0x578, 0x582, 0x569, 0x575, 0x578, 0x582, 0x576 };
static const symbol s_2_17[3] = { 0x561, 0x56E, 0x578 };
static const symbol s_2_18[2] = { 0x56B, 0x579 };
static const symbol s_2_19[3] = { 0x578, 0x582, 0x57D };
static const symbol s_2_20[4] = { 0x578, 0x582, 0x57D, 0x57F };
static const symbol s_2_21[3] = { 0x563, 0x561, 0x580 };
static const symbol s_2_22[3] = { 0x57E, 0x578, 0x580 };
static const symbol s_2_23[4] = { 0x561, 0x57E, 0x578, 0x580 };
static const symbol s_2_24[2] = { 0x578, 0x581 };
static const symbol s_2_25[4] = { 0x561, 0x576, 0x585, 0x581 };
static const symbol s_2_26[2] = { 0x578, 0x582 };
static const symbol s_2_27[1] = { 0x584 };
static const symbol s_2_28[3] = { 0x579, 0x565, 0x584 };
static const symbol s_2_29[2] = { 0x56B, 0x584 };
static const symbol s_2_30[4] = { 0x561, 0x56C, 0x56B, 0x584 };
static const symbol s_2_31[4] = { 0x561, 0x576, 0x56B, 0x584 };
static const symbol s_2_32[4] = { 0x57E, 0x561, 0x56E, 0x584 };
static const symbol s_2_33[4] = { 0x578, 0x582, 0x575, 0x584 };
static const symbol s_2_34[3] = { 0x565, 0x576, 0x584 };
static const symbol s_2_35[3] = { 0x578, 0x576, 0x584 };
static const symbol s_2_36[4] = { 0x578, 0x582, 0x576, 0x584 };
static const symbol s_2_37[5] = { 0x574, 0x578, 0x582, 0x576, 0x584 };
static const symbol s_2_38[3] = { 0x56B, 0x579, 0x584 };
static const symbol s_2_39[3] = { 0x561, 0x580, 0x584 };
static const struct among a_2[40] = {
{ 3, s_2_0, 0, 1, 0},
{ 4, s_2_1, 0, 1, 0},
{ 4, s_2_2, 0, 1, 0},
{ 2, s_2_3, 0, 1, 0},
{ 2, s_2_4, 0, 1, 0},
{ 2, s_2_5, 0, 1, 0},
{ 3, s_2_6, -1, 1, 0},
{ 4, s_2_7, -2, 1, 0},
{ 2, s_2_8, 0, 1, 0},
{ 3, s_2_9, 0, 1, 0},
{ 2, s_2_10, 0, 1, 0},
{ 3, s_2_11, -1, 1, 0},
{ 4, s_2_12, -2, 1, 0},
{ 4, s_2_13, -3, 1, 0},
{ 4, s_2_14, 0, 1, 0},
{ 4, s_2_15, 0, 1, 0},
{ 7, s_2_16, -1, 1, 0},
{ 3, s_2_17, 0, 1, 0},
{ 2, s_2_18, 0, 1, 0},
{ 3, s_2_19, 0, 1, 0},
{ 4, s_2_20, 0, 1, 0},
{ 3, s_2_21, 0, 1, 0},
{ 3, s_2_22, 0, 1, 0},
{ 4, s_2_23, -1, 1, 0},
{ 2, s_2_24, 0, 1, 0},
{ 4, s_2_25, 0, 1, 0},
{ 2, s_2_26, 0, 1, 0},
{ 1, s_2_27, 0, 1, 0},
{ 3, s_2_28, -1, 1, 0},
{ 2, s_2_29, -2, 1, 0},
{ 4, s_2_30, -1, 1, 0},
{ 4, s_2_31, -2, 1, 0},
{ 4, s_2_32, -5, 1, 0},
{ 4, s_2_33, -6, 1, 0},
{ 3, s_2_34, -7, 1, 0},
{ 3, s_2_35, -8, 1, 0},
{ 4, s_2_36, -9, 1, 0},
{ 5, s_2_37, -1, 1, 0},
{ 3, s_2_38, -11, 1, 0},
{ 3, s_2_39, -12, 1, 0}
};

static const symbol s_3_0[2] = { 0x57D, 0x561 };
static const symbol s_3_1[2] = { 0x57E, 0x561 };
static const symbol s_3_2[3] = { 0x561, 0x574, 0x562 };
static const symbol s_3_3[1] = { 0x564 };
static const symbol s_3_4[3] = { 0x561, 0x576, 0x564 };
static const symbol s_3_5[7] = { 0x578, 0x582, 0x569, 0x575, 0x561, 0x576, 0x564 };
static const symbol s_3_6[4] = { 0x57E, 0x561, 0x576, 0x564 };
static const symbol s_3_7[3] = { 0x578, 0x57B, 0x564 };
static const symbol s_3_8[3] = { 0x565, 0x580, 0x564 };
static const symbol s_3_9[4] = { 0x576, 0x565, 0x580, 0x564 };
static const symbol s_3_10[3] = { 0x578, 0x582, 0x564 };
static const symbol s_3_11[1] = { 0x568 };
static const symbol s_3_12[3] = { 0x561, 0x576, 0x568 };
static const symbol s_3_13[7] = { 0x578, 0x582, 0x569, 0x575, 0x561, 0x576, 0x568 };
static const symbol s_3_14[4] = { 0x57E, 0x561, 0x576, 0x568 };
static const symbol s_3_15[3] = { 0x578, 0x57B, 0x568 };
static const symbol s_3_16[3] = { 0x565, 0x580, 0x568 };
static const symbol s_3_17[4] = { 0x576, 0x565, 0x580, 0x568 };
static const symbol s_3_18[1] = { 0x56B };
static const symbol s_3_19[2] = { 0x57E, 0x56B };
static const symbol s_3_20[3] = { 0x565, 0x580, 0x56B };
static const symbol s_3_21[4] = { 0x576, 0x565, 0x580, 0x56B };
static const symbol s_3_22[5] = { 0x561, 0x576, 0x578, 0x582, 0x574 };
static const symbol s_3_23[5] = { 0x565, 0x580, 0x578, 0x582, 0x574 };
static const symbol s_3_24[6] = { 0x576, 0x565, 0x580, 0x578, 0x582, 0x574 };
static const symbol s_3_25[1] = { 0x576 };
static const symbol s_3_26[2] = { 0x561, 0x576 };
static const symbol s_3_27[6] = { 0x578, 0x582, 0x569, 0x575, 0x561, 0x576 };
static const symbol s_3_28[3] = { 0x57E, 0x561, 0x576 };
static const symbol s_3_29[2] = { 0x56B, 0x576 };
static const symbol s_3_30[4] = { 0x565, 0x580, 0x56B, 0x576 };
static const symbol s_3_31[5] = { 0x576, 0x565, 0x580, 0x56B, 0x576 };
static const symbol s_3_32[7] = { 0x578, 0x582, 0x569, 0x575, 0x561, 0x576, 0x576 };
static const symbol s_3_33[3] = { 0x565, 0x580, 0x576 };
static const symbol s_3_34[4] = { 0x576, 0x565, 0x580, 0x576 };
static const symbol s_3_35[3] = { 0x578, 0x582, 0x576 };
static const symbol s_3_36[2] = { 0x578, 0x57B };
static const symbol s_3_37[7] = { 0x578, 0x582, 0x569, 0x575, 0x561, 0x576, 0x57D };
static const symbol s_3_38[4] = { 0x57E, 0x561, 0x576, 0x57D };
static const symbol s_3_39[3] = { 0x578, 0x57B, 0x57D };
static const symbol s_3_40[2] = { 0x578, 0x57E };
static const symbol s_3_41[4] = { 0x561, 0x576, 0x578, 0x57E };
static const symbol s_3_42[3] = { 0x57E, 0x578, 0x57E };
static const symbol s_3_43[4] = { 0x565, 0x580, 0x578, 0x57E };
static const symbol s_3_44[5] = { 0x576, 0x565, 0x580, 0x578, 0x57E };
static const symbol s_3_45[2] = { 0x565, 0x580 };
static const symbol s_3_46[3] = { 0x576, 0x565, 0x580 };
static const symbol s_3_47[1] = { 0x581 };
static const symbol s_3_48[2] = { 0x56B, 0x581 };
static const symbol s_3_49[5] = { 0x57E, 0x561, 0x576, 0x56B, 0x581 };
static const symbol s_3_50[4] = { 0x578, 0x57B, 0x56B, 0x581 };
static const symbol s_3_51[3] = { 0x57E, 0x56B, 0x581 };
static const symbol s_3_52[4] = { 0x565, 0x580, 0x56B, 0x581 };
static const symbol s_3_53[5] = { 0x576, 0x565, 0x580, 0x56B, 0x581 };
static const symbol s_3_54[3] = { 0x581, 0x56B, 0x581 };
static const symbol s_3_55[2] = { 0x578, 0x581 };
static const symbol s_3_56[3] = { 0x578, 0x582, 0x581 };
static const struct among a_3[57] = {
{ 2, s_3_0, 0, 1, 0},
{ 2, s_3_1, 0, 1, 0},
{ 3, s_3_2, 0, 1, 0},
{ 1, s_3_3, 0, 1, 0},
{ 3, s_3_4, -1, 1, 0},
{ 7, s_3_5, -1, 1, 0},
{ 4, s_3_6, -2, 1, 0},
{ 3, s_3_7, -4, 1, 0},
{ 3, s_3_8, -5, 1, 0},
{ 4, s_3_9, -1, 1, 0},
{ 3, s_3_10, -7, 1, 0},
{ 1, s_3_11, 0, 1, 0},
{ 3, s_3_12, -1, 1, 0},
{ 7, s_3_13, -1, 1, 0},
{ 4, s_3_14, -2, 1, 0},
{ 3, s_3_15, -4, 1, 0},
{ 3, s_3_16, -5, 1, 0},
{ 4, s_3_17, -1, 1, 0},
{ 1, s_3_18, 0, 1, 0},
{ 2, s_3_19, -1, 1, 0},
{ 3, s_3_20, -2, 1, 0},
{ 4, s_3_21, -1, 1, 0},
{ 5, s_3_22, 0, 1, 0},
{ 5, s_3_23, 0, 1, 0},
{ 6, s_3_24, -1, 1, 0},
{ 1, s_3_25, 0, 1, 0},
{ 2, s_3_26, -1, 1, 0},
{ 6, s_3_27, -1, 1, 0},
{ 3, s_3_28, -2, 1, 0},
{ 2, s_3_29, -4, 1, 0},
{ 4, s_3_30, -1, 1, 0},
{ 5, s_3_31, -1, 1, 0},
{ 7, s_3_32, -7, 1, 0},
{ 3, s_3_33, -8, 1, 0},
{ 4, s_3_34, -1, 1, 0},
{ 3, s_3_35, -10, 1, 0},
{ 2, s_3_36, 0, 1, 0},
{ 7, s_3_37, 0, 1, 0},
{ 4, s_3_38, 0, 1, 0},
{ 3, s_3_39, 0, 1, 0},
{ 2, s_3_40, 0, 1, 0},
{ 4, s_3_41, -1, 1, 0},
{ 3, s_3_42, -2, 1, 0},
{ 4, s_3_43, -3, 1, 0},
{ 5, s_3_44, -1, 1, 0},
{ 2, s_3_45, 0, 1, 0},
{ 3, s_3_46, -1, 1, 0},
{ 1, s_3_47, 0, 1, 0},
{ 2, s_3_48, -1, 1, 0},
{ 5, s_3_49, -1, 1, 0},
{ 4, s_3_50, -2, 1, 0},
{ 3, s_3_51, -3, 1, 0},
{ 4, s_3_52, -4, 1, 0},
{ 5, s_3_53, -1, 1, 0},
{ 3, s_3_54, -6, 1, 0},
{ 2, s_3_55, -8, 1, 0},
{ 3, s_3_56, -9, 1, 0}
};

static const unsigned char g_v[] = { 209, 4, 128, 0, 18 };

extern int armenian_stem(struct SN_env * z) {
    int i_p2;
    int i_pV;
    i_pV = z->l;
    i_p2 = z->l;
    {
        int v_1 = z->c;
        {
            int ret = out_grouping(z, g_v, 1377, 1413, 1);
            if (ret < 0) goto lab1;
            z->c += ret;
        }
        i_pV = z->c;
        {
            int ret = in_grouping(z, g_v, 1377, 1413, 1);
            if (ret < 0) goto lab1;
            z->c += ret;
        }
        {
            int ret = out_grouping(z, g_v, 1377, 1413, 1);
            if (ret < 0) goto lab1;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 1377, 1413, 1);
            if (ret < 0) goto lab1;
            z->c += ret;
        }
        i_p2 = z->c;
    lab1:
        z->c = v_1;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_2;
        if (z->c < i_pV) return 0;
        v_2 = z->lb; z->lb = i_pV;
        {
            int v_3 = z->l - z->c;
            z->ket = z->c;
            if (!find_among_b(z, a_3, 57, 0)) goto lab2;
            z->bra = z->c;
            if (i_p2 > z->c) goto lab2;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab2:
            z->c = z->l - v_3;
        }
        {
            int v_4 = z->l - z->c;
            z->ket = z->c;
            if (!find_among_b(z, a_1, 71, 0)) goto lab3;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab3:
            z->c = z->l - v_4;
        }
        {
            int v_5 = z->l - z->c;
            z->ket = z->c;
            if (!find_among_b(z, a_0, 23, 0)) goto lab4;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab4:
            z->c = z->l - v_5;
        }
        {
            int v_6 = z->l - z->c;
            z->ket = z->c;
            if (!find_among_b(z, a_2, 40, 0)) goto lab5;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab5:
            z->c = z->l - v_6;
        }
        z->lb = v_2;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * armenian_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
