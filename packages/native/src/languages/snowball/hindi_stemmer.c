/*
 * Generated from algorithms/hindi.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "hindi_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int hindi_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_CONSONANT(struct SN_env * z);


static const symbol s_0_0[2] = { 0x906, 0x901 };
static const symbol s_0_1[2] = { 0x93E, 0x901 };
static const symbol s_0_2[4] = { 0x907, 0x92F, 0x93E, 0x901 };
static const symbol s_0_3[5] = { 0x906, 0x907, 0x92F, 0x93E, 0x901 };
static const symbol s_0_4[5] = { 0x93E, 0x907, 0x92F, 0x93E, 0x901 };
static const symbol s_0_5[4] = { 0x93F, 0x92F, 0x93E, 0x901 };
static const symbol s_0_6[2] = { 0x906, 0x902 };
static const symbol s_0_7[3] = { 0x909, 0x906, 0x902 };
static const symbol s_0_8[3] = { 0x941, 0x906, 0x902 };
static const symbol s_0_9[2] = { 0x908, 0x902 };
static const symbol s_0_10[3] = { 0x906, 0x908, 0x902 };
static const symbol s_0_11[3] = { 0x93E, 0x908, 0x902 };
static const symbol s_0_12[2] = { 0x90F, 0x902 };
static const symbol s_0_13[3] = { 0x906, 0x90F, 0x902 };
static const symbol s_0_14[3] = { 0x909, 0x90F, 0x902 };
static const symbol s_0_15[3] = { 0x93E, 0x90F, 0x902 };
static const symbol s_0_16[4] = { 0x924, 0x93E, 0x90F, 0x902 };
static const symbol s_0_17[5] = { 0x905, 0x924, 0x93E, 0x90F, 0x902 };
static const symbol s_0_18[4] = { 0x928, 0x93E, 0x90F, 0x902 };
static const symbol s_0_19[5] = { 0x905, 0x928, 0x93E, 0x90F, 0x902 };
static const symbol s_0_20[3] = { 0x941, 0x90F, 0x902 };
static const symbol s_0_21[2] = { 0x913, 0x902 };
static const symbol s_0_22[3] = { 0x906, 0x913, 0x902 };
static const symbol s_0_23[3] = { 0x909, 0x913, 0x902 };
static const symbol s_0_24[3] = { 0x93E, 0x913, 0x902 };
static const symbol s_0_25[4] = { 0x924, 0x93E, 0x913, 0x902 };
static const symbol s_0_26[5] = { 0x905, 0x924, 0x93E, 0x913, 0x902 };
static const symbol s_0_27[4] = { 0x928, 0x93E, 0x913, 0x902 };
static const symbol s_0_28[5] = { 0x905, 0x928, 0x93E, 0x913, 0x902 };
static const symbol s_0_29[3] = { 0x941, 0x913, 0x902 };
static const symbol s_0_30[2] = { 0x93E, 0x902 };
static const symbol s_0_31[4] = { 0x907, 0x92F, 0x93E, 0x902 };
static const symbol s_0_32[5] = { 0x906, 0x907, 0x92F, 0x93E, 0x902 };
static const symbol s_0_33[5] = { 0x93E, 0x907, 0x92F, 0x93E, 0x902 };
static const symbol s_0_34[4] = { 0x93F, 0x92F, 0x93E, 0x902 };
static const symbol s_0_35[2] = { 0x940, 0x902 };
static const symbol s_0_36[3] = { 0x924, 0x940, 0x902 };
static const symbol s_0_37[4] = { 0x905, 0x924, 0x940, 0x902 };
static const symbol s_0_38[4] = { 0x906, 0x924, 0x940, 0x902 };
static const symbol s_0_39[4] = { 0x93E, 0x924, 0x940, 0x902 };
static const symbol s_0_40[2] = { 0x947, 0x902 };
static const symbol s_0_41[2] = { 0x94B, 0x902 };
static const symbol s_0_42[4] = { 0x907, 0x92F, 0x94B, 0x902 };
static const symbol s_0_43[5] = { 0x906, 0x907, 0x92F, 0x94B, 0x902 };
static const symbol s_0_44[5] = { 0x93E, 0x907, 0x92F, 0x94B, 0x902 };
static const symbol s_0_45[4] = { 0x93F, 0x92F, 0x94B, 0x902 };
static const symbol s_0_46[1] = { 0x905 };
static const symbol s_0_47[1] = { 0x906 };
static const symbol s_0_48[1] = { 0x907 };
static const symbol s_0_49[1] = { 0x908 };
static const symbol s_0_50[2] = { 0x906, 0x908 };
static const symbol s_0_51[2] = { 0x93E, 0x908 };
static const symbol s_0_52[1] = { 0x909 };
static const symbol s_0_53[1] = { 0x90A };
static const symbol s_0_54[1] = { 0x90F };
static const symbol s_0_55[2] = { 0x906, 0x90F };
static const symbol s_0_56[2] = { 0x907, 0x90F };
static const symbol s_0_57[3] = { 0x906, 0x907, 0x90F };
static const symbol s_0_58[3] = { 0x93E, 0x907, 0x90F };
static const symbol s_0_59[2] = { 0x93E, 0x90F };
static const symbol s_0_60[2] = { 0x93F, 0x90F };
static const symbol s_0_61[1] = { 0x913 };
static const symbol s_0_62[2] = { 0x906, 0x913 };
static const symbol s_0_63[2] = { 0x93E, 0x913 };
static const symbol s_0_64[2] = { 0x915, 0x930 };
static const symbol s_0_65[3] = { 0x905, 0x915, 0x930 };
static const symbol s_0_66[3] = { 0x906, 0x915, 0x930 };
static const symbol s_0_67[3] = { 0x93E, 0x915, 0x930 };
static const symbol s_0_68[1] = { 0x93E };
static const symbol s_0_69[4] = { 0x90A, 0x902, 0x917, 0x93E };
static const symbol s_0_70[5] = { 0x906, 0x90A, 0x902, 0x917, 0x93E };
static const symbol s_0_71[5] = { 0x93E, 0x90A, 0x902, 0x917, 0x93E };
static const symbol s_0_72[4] = { 0x942, 0x902, 0x917, 0x93E };
static const symbol s_0_73[3] = { 0x90F, 0x917, 0x93E };
static const symbol s_0_74[4] = { 0x906, 0x90F, 0x917, 0x93E };
static const symbol s_0_75[4] = { 0x93E, 0x90F, 0x917, 0x93E };
static const symbol s_0_76[3] = { 0x947, 0x917, 0x93E };
static const symbol s_0_77[2] = { 0x924, 0x93E };
static const symbol s_0_78[3] = { 0x905, 0x924, 0x93E };
static const symbol s_0_79[3] = { 0x906, 0x924, 0x93E };
static const symbol s_0_80[3] = { 0x93E, 0x924, 0x93E };
static const symbol s_0_81[2] = { 0x928, 0x93E };
static const symbol s_0_82[3] = { 0x905, 0x928, 0x93E };
static const symbol s_0_83[3] = { 0x906, 0x928, 0x93E };
static const symbol s_0_84[3] = { 0x93E, 0x928, 0x93E };
static const symbol s_0_85[3] = { 0x906, 0x92F, 0x93E };
static const symbol s_0_86[3] = { 0x93E, 0x92F, 0x93E };
static const symbol s_0_87[1] = { 0x93F };
static const symbol s_0_88[1] = { 0x940 };
static const symbol s_0_89[4] = { 0x90A, 0x902, 0x917, 0x940 };
static const symbol s_0_90[5] = { 0x906, 0x90A, 0x902, 0x917, 0x940 };
static const symbol s_0_91[5] = { 0x93E, 0x90A, 0x902, 0x917, 0x940 };
static const symbol s_0_92[4] = { 0x90F, 0x902, 0x917, 0x940 };
static const symbol s_0_93[5] = { 0x906, 0x90F, 0x902, 0x917, 0x940 };
static const symbol s_0_94[5] = { 0x93E, 0x90F, 0x902, 0x917, 0x940 };
static const symbol s_0_95[4] = { 0x942, 0x902, 0x917, 0x940 };
static const symbol s_0_96[4] = { 0x947, 0x902, 0x917, 0x940 };
static const symbol s_0_97[3] = { 0x90F, 0x917, 0x940 };
static const symbol s_0_98[4] = { 0x906, 0x90F, 0x917, 0x940 };
static const symbol s_0_99[4] = { 0x93E, 0x90F, 0x917, 0x940 };
static const symbol s_0_100[3] = { 0x913, 0x917, 0x940 };
static const symbol s_0_101[4] = { 0x906, 0x913, 0x917, 0x940 };
static const symbol s_0_102[4] = { 0x93E, 0x913, 0x917, 0x940 };
static const symbol s_0_103[3] = { 0x947, 0x917, 0x940 };
static const symbol s_0_104[3] = { 0x94B, 0x917, 0x940 };
static const symbol s_0_105[2] = { 0x924, 0x940 };
static const symbol s_0_106[3] = { 0x905, 0x924, 0x940 };
static const symbol s_0_107[3] = { 0x906, 0x924, 0x940 };
static const symbol s_0_108[3] = { 0x93E, 0x924, 0x940 };
static const symbol s_0_109[2] = { 0x928, 0x940 };
static const symbol s_0_110[3] = { 0x905, 0x928, 0x940 };
static const symbol s_0_111[1] = { 0x941 };
static const symbol s_0_112[1] = { 0x942 };
static const symbol s_0_113[1] = { 0x947 };
static const symbol s_0_114[4] = { 0x90F, 0x902, 0x917, 0x947 };
static const symbol s_0_115[5] = { 0x906, 0x90F, 0x902, 0x917, 0x947 };
static const symbol s_0_116[5] = { 0x93E, 0x90F, 0x902, 0x917, 0x947 };
static const symbol s_0_117[4] = { 0x947, 0x902, 0x917, 0x947 };
static const symbol s_0_118[3] = { 0x913, 0x917, 0x947 };
static const symbol s_0_119[4] = { 0x906, 0x913, 0x917, 0x947 };
static const symbol s_0_120[4] = { 0x93E, 0x913, 0x917, 0x947 };
static const symbol s_0_121[3] = { 0x94B, 0x917, 0x947 };
static const symbol s_0_122[2] = { 0x924, 0x947 };
static const symbol s_0_123[3] = { 0x905, 0x924, 0x947 };
static const symbol s_0_124[3] = { 0x906, 0x924, 0x947 };
static const symbol s_0_125[3] = { 0x93E, 0x924, 0x947 };
static const symbol s_0_126[2] = { 0x928, 0x947 };
static const symbol s_0_127[3] = { 0x905, 0x928, 0x947 };
static const symbol s_0_128[3] = { 0x906, 0x928, 0x947 };
static const symbol s_0_129[3] = { 0x93E, 0x928, 0x947 };
static const symbol s_0_130[1] = { 0x94B };
static const symbol s_0_131[1] = { 0x94D };
static const struct among a_0[132] = {
{ 2, s_0_0, 0, -1, 0},
{ 2, s_0_1, 0, -1, 0},
{ 4, s_0_2, -1, -1, 0},
{ 5, s_0_3, -1, -1, 0},
{ 5, s_0_4, -2, -1, 0},
{ 4, s_0_5, -4, -1, 0},
{ 2, s_0_6, 0, -1, 0},
{ 3, s_0_7, -1, -1, 0},
{ 3, s_0_8, -2, -1, 0},
{ 2, s_0_9, 0, -1, 0},
{ 3, s_0_10, -1, -1, 0},
{ 3, s_0_11, -2, -1, 0},
{ 2, s_0_12, 0, -1, 0},
{ 3, s_0_13, -1, -1, 0},
{ 3, s_0_14, -2, -1, 0},
{ 3, s_0_15, -3, -1, 0},
{ 4, s_0_16, -1, -1, 1},
{ 5, s_0_17, -1, -1, 0},
{ 4, s_0_18, -3, -1, 1},
{ 5, s_0_19, -1, -1, 0},
{ 3, s_0_20, -8, -1, 0},
{ 2, s_0_21, 0, -1, 0},
{ 3, s_0_22, -1, -1, 0},
{ 3, s_0_23, -2, -1, 0},
{ 3, s_0_24, -3, -1, 0},
{ 4, s_0_25, -1, -1, 1},
{ 5, s_0_26, -1, -1, 0},
{ 4, s_0_27, -3, -1, 1},
{ 5, s_0_28, -1, -1, 0},
{ 3, s_0_29, -8, -1, 0},
{ 2, s_0_30, 0, -1, 0},
{ 4, s_0_31, -1, -1, 0},
{ 5, s_0_32, -1, -1, 0},
{ 5, s_0_33, -2, -1, 0},
{ 4, s_0_34, -4, -1, 0},
{ 2, s_0_35, 0, -1, 0},
{ 3, s_0_36, -1, -1, 1},
{ 4, s_0_37, -1, -1, 0},
{ 4, s_0_38, -2, -1, 0},
{ 4, s_0_39, -3, -1, 0},
{ 2, s_0_40, 0, -1, 0},
{ 2, s_0_41, 0, -1, 0},
{ 4, s_0_42, -1, -1, 0},
{ 5, s_0_43, -1, -1, 0},
{ 5, s_0_44, -2, -1, 0},
{ 4, s_0_45, -4, -1, 0},
{ 1, s_0_46, 0, -1, 0},
{ 1, s_0_47, 0, -1, 0},
{ 1, s_0_48, 0, -1, 0},
{ 1, s_0_49, 0, -1, 0},
{ 2, s_0_50, -1, -1, 0},
{ 2, s_0_51, -2, -1, 0},
{ 1, s_0_52, 0, -1, 0},
{ 1, s_0_53, 0, -1, 0},
{ 1, s_0_54, 0, -1, 0},
{ 2, s_0_55, -1, -1, 0},
{ 2, s_0_56, -2, -1, 0},
{ 3, s_0_57, -1, -1, 0},
{ 3, s_0_58, -2, -1, 0},
{ 2, s_0_59, -5, -1, 0},
{ 2, s_0_60, -6, -1, 0},
{ 1, s_0_61, 0, -1, 0},
{ 2, s_0_62, -1, -1, 0},
{ 2, s_0_63, -2, -1, 0},
{ 2, s_0_64, 0, -1, 1},
{ 3, s_0_65, -1, -1, 0},
{ 3, s_0_66, -2, -1, 0},
{ 3, s_0_67, -3, -1, 0},
{ 1, s_0_68, 0, -1, 0},
{ 4, s_0_69, -1, -1, 0},
{ 5, s_0_70, -1, -1, 0},
{ 5, s_0_71, -2, -1, 0},
{ 4, s_0_72, -4, -1, 0},
{ 3, s_0_73, -5, -1, 0},
{ 4, s_0_74, -1, -1, 0},
{ 4, s_0_75, -2, -1, 0},
{ 3, s_0_76, -8, -1, 0},
{ 2, s_0_77, -9, -1, 1},
{ 3, s_0_78, -1, -1, 0},
{ 3, s_0_79, -2, -1, 0},
{ 3, s_0_80, -3, -1, 0},
{ 2, s_0_81, -13, -1, 1},
{ 3, s_0_82, -1, -1, 0},
{ 3, s_0_83, -2, -1, 0},
{ 3, s_0_84, -3, -1, 0},
{ 3, s_0_85, -17, -1, 0},
{ 3, s_0_86, -18, -1, 0},
{ 1, s_0_87, 0, -1, 0},
{ 1, s_0_88, 0, -1, 0},
{ 4, s_0_89, -1, -1, 0},
{ 5, s_0_90, -1, -1, 0},
{ 5, s_0_91, -2, -1, 0},
{ 4, s_0_92, -4, -1, 0},
{ 5, s_0_93, -1, -1, 0},
{ 5, s_0_94, -2, -1, 0},
{ 4, s_0_95, -7, -1, 0},
{ 4, s_0_96, -8, -1, 0},
{ 3, s_0_97, -9, -1, 0},
{ 4, s_0_98, -1, -1, 0},
{ 4, s_0_99, -2, -1, 0},
{ 3, s_0_100, -12, -1, 0},
{ 4, s_0_101, -1, -1, 0},
{ 4, s_0_102, -2, -1, 0},
{ 3, s_0_103, -15, -1, 0},
{ 3, s_0_104, -16, -1, 0},
{ 2, s_0_105, -17, -1, 1},
{ 3, s_0_106, -1, -1, 0},
{ 3, s_0_107, -2, -1, 0},
{ 3, s_0_108, -3, -1, 0},
{ 2, s_0_109, -21, -1, 1},
{ 3, s_0_110, -1, -1, 0},
{ 1, s_0_111, 0, -1, 0},
{ 1, s_0_112, 0, -1, 0},
{ 1, s_0_113, 0, -1, 0},
{ 4, s_0_114, -1, -1, 0},
{ 5, s_0_115, -1, -1, 0},
{ 5, s_0_116, -2, -1, 0},
{ 4, s_0_117, -4, -1, 0},
{ 3, s_0_118, -5, -1, 0},
{ 4, s_0_119, -1, -1, 0},
{ 4, s_0_120, -2, -1, 0},
{ 3, s_0_121, -8, -1, 0},
{ 2, s_0_122, -9, -1, 1},
{ 3, s_0_123, -1, -1, 0},
{ 3, s_0_124, -2, -1, 0},
{ 3, s_0_125, -3, -1, 0},
{ 2, s_0_126, -13, -1, 1},
{ 3, s_0_127, -1, -1, 0},
{ 3, s_0_128, -2, -1, 0},
{ 3, s_0_129, -3, -1, 0},
{ 1, s_0_130, 0, -1, 0},
{ 1, s_0_131, 0, -1, 0}
};

static const unsigned char g_consonant[] = { 255, 255, 255, 255, 159, 0, 0, 0, 248, 7 };

static int r_CONSONANT(struct SN_env * z) {
    return !in_grouping_b(z, g_consonant, 2325, 2399, 0);
}

extern int hindi_stem(struct SN_env * z) {
    if (z->c >= z->l) return 0;
    z->c++;
    z->lb = z->c; z->c = z->l;
    z->ket = z->c;
    if (!find_among_b(z, a_0, 132, r_CONSONANT)) return 0;
    z->bra = z->c;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * hindi_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
