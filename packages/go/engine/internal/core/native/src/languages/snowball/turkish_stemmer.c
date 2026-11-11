/*
 * Generated from algorithms/turkish.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "turkish_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int turkish_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_stem_suffix_chain_before_ki(struct SN_env * z);
static int r_1(struct SN_env * z);
static int r_2(struct SN_env * z);
static int r_mark_ysA(struct SN_env * z);
static int r_mark_ymUs_(struct SN_env * z);
static int r_mark_yDU(struct SN_env * z);
static int r_mark_yUz(struct SN_env * z);
static int r_mark_yUm(struct SN_env * z);
static int r_mark_possessives(struct SN_env * z);
static int r_mark_sUnUz(struct SN_env * z);
static int r_mark_sUn(struct SN_env * z);
static int r_mark_sU(struct SN_env * z);
static int r_mark_nUn(struct SN_env * z);
static int r_mark_ndA(struct SN_env * z);
static int r_mark_lArI(struct SN_env * z);
static int r_mark_lAr(struct SN_env * z);
static int r_mark_DUr(struct SN_env * z);
static int r_mark_DA(struct SN_env * z);
static int r_check_vowel_harmony(struct SN_env * z);

static const symbol s_0[] = { 'k', 'i' };
static const symbol s_1[] = { 'k', 'e', 'n' };
static const symbol s_2[] = { 'a', 'd' };
static const symbol s_3[] = { 's', 'o', 'y' };
static const symbol s_4[] = { 0x131 };
static const symbol s_5[] = { 'i' };
static const symbol s_6[] = { 'u' };
static const symbol s_7[] = { 0xFC };
static const symbol s_8[] = { 'p' };
static const symbol s_9[] = { 0xE7 };
static const symbol s_10[] = { 't' };
static const symbol s_11[] = { 'k' };

static const symbol s_0_0[1] = { 'm' };
static const symbol s_0_1[1] = { 'n' };
static const symbol s_0_2[3] = { 'm', 'i', 'z' };
static const symbol s_0_3[3] = { 'n', 'i', 'z' };
static const symbol s_0_4[3] = { 'm', 'u', 'z' };
static const symbol s_0_5[3] = { 'n', 'u', 'z' };
static const symbol s_0_6[3] = { 'm', 0xFC, 'z' };
static const symbol s_0_7[3] = { 'n', 0xFC, 'z' };
static const symbol s_0_8[3] = { 'm', 0x131, 'z' };
static const symbol s_0_9[3] = { 'n', 0x131, 'z' };
static const struct among a_0[10] = {
{ 1, s_0_0, 0, -1, 0},
{ 1, s_0_1, 0, -1, 0},
{ 3, s_0_2, 0, -1, 0},
{ 3, s_0_3, 0, -1, 0},
{ 3, s_0_4, 0, -1, 0},
{ 3, s_0_5, 0, -1, 0},
{ 3, s_0_6, 0, -1, 0},
{ 3, s_0_7, 0, -1, 0},
{ 3, s_0_8, 0, -1, 0},
{ 3, s_0_9, 0, -1, 0}
};

static const symbol s_1_0[4] = { 'l', 'e', 'r', 'i' };
static const symbol s_1_1[4] = { 'l', 'a', 'r', 0x131 };
static const struct among a_1[2] = {
{ 4, s_1_0, 0, -1, 0},
{ 4, s_1_1, 0, -1, 0}
};

static const symbol s_2_0[2] = { 'n', 'i' };
static const symbol s_2_1[2] = { 'n', 'u' };
static const symbol s_2_2[2] = { 'n', 0xFC };
static const symbol s_2_3[2] = { 'n', 0x131 };
static const struct among a_2[4] = {
{ 2, s_2_0, 0, -1, 0},
{ 2, s_2_1, 0, -1, 0},
{ 2, s_2_2, 0, -1, 0},
{ 2, s_2_3, 0, -1, 0}
};

static const symbol s_3_0[2] = { 'i', 'n' };
static const symbol s_3_1[2] = { 'u', 'n' };
static const symbol s_3_2[2] = { 0xFC, 'n' };
static const symbol s_3_3[2] = { 0x131, 'n' };
static const struct among a_3[4] = {
{ 2, s_3_0, 0, -1, 0},
{ 2, s_3_1, 0, -1, 0},
{ 2, s_3_2, 0, -1, 0},
{ 2, s_3_3, 0, -1, 0}
};

static const symbol s_5_0[2] = { 'n', 'a' };
static const symbol s_5_1[2] = { 'n', 'e' };
static const struct among a_5[2] = {
{ 2, s_5_0, 0, -1, 0},
{ 2, s_5_1, 0, -1, 0}
};

static const symbol s_6_0[2] = { 'd', 'a' };
static const symbol s_6_1[2] = { 't', 'a' };
static const symbol s_6_2[2] = { 'd', 'e' };
static const symbol s_6_3[2] = { 't', 'e' };
static const struct among a_6[4] = {
{ 2, s_6_0, 0, -1, 0},
{ 2, s_6_1, 0, -1, 0},
{ 2, s_6_2, 0, -1, 0},
{ 2, s_6_3, 0, -1, 0}
};

static const symbol s_7_0[3] = { 'n', 'd', 'a' };
static const symbol s_7_1[3] = { 'n', 'd', 'e' };
static const struct among a_7[2] = {
{ 3, s_7_0, 0, -1, 0},
{ 3, s_7_1, 0, -1, 0}
};

static const symbol s_8_0[3] = { 'd', 'a', 'n' };
static const symbol s_8_1[3] = { 't', 'a', 'n' };
static const symbol s_8_2[3] = { 'd', 'e', 'n' };
static const symbol s_8_3[3] = { 't', 'e', 'n' };
static const struct among a_8[4] = {
{ 3, s_8_0, 0, -1, 0},
{ 3, s_8_1, 0, -1, 0},
{ 3, s_8_2, 0, -1, 0},
{ 3, s_8_3, 0, -1, 0}
};

static const symbol s_9_0[4] = { 'n', 'd', 'a', 'n' };
static const symbol s_9_1[4] = { 'n', 'd', 'e', 'n' };
static const struct among a_9[2] = {
{ 4, s_9_0, 0, -1, 0},
{ 4, s_9_1, 0, -1, 0}
};

static const symbol s_10_0[2] = { 'l', 'a' };
static const symbol s_10_1[2] = { 'l', 'e' };
static const struct among a_10[2] = {
{ 2, s_10_0, 0, -1, 0},
{ 2, s_10_1, 0, -1, 0}
};

static const symbol s_11_0[2] = { 'c', 'a' };
static const symbol s_11_1[2] = { 'c', 'e' };
static const struct among a_11[2] = {
{ 2, s_11_0, 0, -1, 0},
{ 2, s_11_1, 0, -1, 0}
};

static const symbol s_12_0[2] = { 'i', 'm' };
static const symbol s_12_1[2] = { 'u', 'm' };
static const symbol s_12_2[2] = { 0xFC, 'm' };
static const symbol s_12_3[2] = { 0x131, 'm' };
static const struct among a_12[4] = {
{ 2, s_12_0, 0, -1, 0},
{ 2, s_12_1, 0, -1, 0},
{ 2, s_12_2, 0, -1, 0},
{ 2, s_12_3, 0, -1, 0}
};

static const symbol s_13_0[3] = { 's', 'i', 'n' };
static const symbol s_13_1[3] = { 's', 'u', 'n' };
static const symbol s_13_2[3] = { 's', 0xFC, 'n' };
static const symbol s_13_3[3] = { 's', 0x131, 'n' };
static const struct among a_13[4] = {
{ 3, s_13_0, 0, -1, 0},
{ 3, s_13_1, 0, -1, 0},
{ 3, s_13_2, 0, -1, 0},
{ 3, s_13_3, 0, -1, 0}
};

static const symbol s_14_0[2] = { 'i', 'z' };
static const symbol s_14_1[2] = { 'u', 'z' };
static const symbol s_14_2[2] = { 0xFC, 'z' };
static const symbol s_14_3[2] = { 0x131, 'z' };
static const struct among a_14[4] = {
{ 2, s_14_0, 0, -1, 0},
{ 2, s_14_1, 0, -1, 0},
{ 2, s_14_2, 0, -1, 0},
{ 2, s_14_3, 0, -1, 0}
};

static const symbol s_15_0[5] = { 's', 'i', 'n', 'i', 'z' };
static const symbol s_15_1[5] = { 's', 'u', 'n', 'u', 'z' };
static const symbol s_15_2[5] = { 's', 0xFC, 'n', 0xFC, 'z' };
static const symbol s_15_3[5] = { 's', 0x131, 'n', 0x131, 'z' };
static const struct among a_15[4] = {
{ 5, s_15_0, 0, -1, 0},
{ 5, s_15_1, 0, -1, 0},
{ 5, s_15_2, 0, -1, 0},
{ 5, s_15_3, 0, -1, 0}
};

static const symbol s_16_0[3] = { 'l', 'a', 'r' };
static const symbol s_16_1[3] = { 'l', 'e', 'r' };
static const struct among a_16[2] = {
{ 3, s_16_0, 0, -1, 0},
{ 3, s_16_1, 0, -1, 0}
};

static const symbol s_17_0[3] = { 'n', 'i', 'z' };
static const symbol s_17_1[3] = { 'n', 'u', 'z' };
static const symbol s_17_2[3] = { 'n', 0xFC, 'z' };
static const symbol s_17_3[3] = { 'n', 0x131, 'z' };
static const struct among a_17[4] = {
{ 3, s_17_0, 0, -1, 0},
{ 3, s_17_1, 0, -1, 0},
{ 3, s_17_2, 0, -1, 0},
{ 3, s_17_3, 0, -1, 0}
};

static const symbol s_18_0[3] = { 'd', 'i', 'r' };
static const symbol s_18_1[3] = { 't', 'i', 'r' };
static const symbol s_18_2[3] = { 'd', 'u', 'r' };
static const symbol s_18_3[3] = { 't', 'u', 'r' };
static const symbol s_18_4[3] = { 'd', 0xFC, 'r' };
static const symbol s_18_5[3] = { 't', 0xFC, 'r' };
static const symbol s_18_6[3] = { 'd', 0x131, 'r' };
static const symbol s_18_7[3] = { 't', 0x131, 'r' };
static const struct among a_18[8] = {
{ 3, s_18_0, 0, -1, 0},
{ 3, s_18_1, 0, -1, 0},
{ 3, s_18_2, 0, -1, 0},
{ 3, s_18_3, 0, -1, 0},
{ 3, s_18_4, 0, -1, 0},
{ 3, s_18_5, 0, -1, 0},
{ 3, s_18_6, 0, -1, 0},
{ 3, s_18_7, 0, -1, 0}
};

static const symbol s_19_0[6] = { 'c', 'a', 's', 0x131, 'n', 'a' };
static const symbol s_19_1[6] = { 'c', 'e', 's', 'i', 'n', 'e' };
static const struct among a_19[2] = {
{ 6, s_19_0, 0, -1, 0},
{ 6, s_19_1, 0, -1, 0}
};

static const symbol s_20_0[2] = { 'd', 'i' };
static const symbol s_20_1[2] = { 't', 'i' };
static const symbol s_20_2[3] = { 'd', 'i', 'k' };
static const symbol s_20_3[3] = { 't', 'i', 'k' };
static const symbol s_20_4[3] = { 'd', 'u', 'k' };
static const symbol s_20_5[3] = { 't', 'u', 'k' };
static const symbol s_20_6[3] = { 'd', 0xFC, 'k' };
static const symbol s_20_7[3] = { 't', 0xFC, 'k' };
static const symbol s_20_8[3] = { 'd', 0x131, 'k' };
static const symbol s_20_9[3] = { 't', 0x131, 'k' };
static const symbol s_20_10[3] = { 'd', 'i', 'm' };
static const symbol s_20_11[3] = { 't', 'i', 'm' };
static const symbol s_20_12[3] = { 'd', 'u', 'm' };
static const symbol s_20_13[3] = { 't', 'u', 'm' };
static const symbol s_20_14[3] = { 'd', 0xFC, 'm' };
static const symbol s_20_15[3] = { 't', 0xFC, 'm' };
static const symbol s_20_16[3] = { 'd', 0x131, 'm' };
static const symbol s_20_17[3] = { 't', 0x131, 'm' };
static const symbol s_20_18[3] = { 'd', 'i', 'n' };
static const symbol s_20_19[3] = { 't', 'i', 'n' };
static const symbol s_20_20[3] = { 'd', 'u', 'n' };
static const symbol s_20_21[3] = { 't', 'u', 'n' };
static const symbol s_20_22[3] = { 'd', 0xFC, 'n' };
static const symbol s_20_23[3] = { 't', 0xFC, 'n' };
static const symbol s_20_24[3] = { 'd', 0x131, 'n' };
static const symbol s_20_25[3] = { 't', 0x131, 'n' };
static const symbol s_20_26[2] = { 'd', 'u' };
static const symbol s_20_27[2] = { 't', 'u' };
static const symbol s_20_28[2] = { 'd', 0xFC };
static const symbol s_20_29[2] = { 't', 0xFC };
static const symbol s_20_30[2] = { 'd', 0x131 };
static const symbol s_20_31[2] = { 't', 0x131 };
static const struct among a_20[32] = {
{ 2, s_20_0, 0, -1, 0},
{ 2, s_20_1, 0, -1, 0},
{ 3, s_20_2, 0, -1, 0},
{ 3, s_20_3, 0, -1, 0},
{ 3, s_20_4, 0, -1, 0},
{ 3, s_20_5, 0, -1, 0},
{ 3, s_20_6, 0, -1, 0},
{ 3, s_20_7, 0, -1, 0},
{ 3, s_20_8, 0, -1, 0},
{ 3, s_20_9, 0, -1, 0},
{ 3, s_20_10, 0, -1, 0},
{ 3, s_20_11, 0, -1, 0},
{ 3, s_20_12, 0, -1, 0},
{ 3, s_20_13, 0, -1, 0},
{ 3, s_20_14, 0, -1, 0},
{ 3, s_20_15, 0, -1, 0},
{ 3, s_20_16, 0, -1, 0},
{ 3, s_20_17, 0, -1, 0},
{ 3, s_20_18, 0, -1, 0},
{ 3, s_20_19, 0, -1, 0},
{ 3, s_20_20, 0, -1, 0},
{ 3, s_20_21, 0, -1, 0},
{ 3, s_20_22, 0, -1, 0},
{ 3, s_20_23, 0, -1, 0},
{ 3, s_20_24, 0, -1, 0},
{ 3, s_20_25, 0, -1, 0},
{ 2, s_20_26, 0, -1, 0},
{ 2, s_20_27, 0, -1, 0},
{ 2, s_20_28, 0, -1, 0},
{ 2, s_20_29, 0, -1, 0},
{ 2, s_20_30, 0, -1, 0},
{ 2, s_20_31, 0, -1, 0}
};

static const symbol s_21_0[2] = { 's', 'a' };
static const symbol s_21_1[2] = { 's', 'e' };
static const symbol s_21_2[3] = { 's', 'a', 'k' };
static const symbol s_21_3[3] = { 's', 'e', 'k' };
static const symbol s_21_4[3] = { 's', 'a', 'm' };
static const symbol s_21_5[3] = { 's', 'e', 'm' };
static const symbol s_21_6[3] = { 's', 'a', 'n' };
static const symbol s_21_7[3] = { 's', 'e', 'n' };
static const struct among a_21[8] = {
{ 2, s_21_0, 0, -1, 0},
{ 2, s_21_1, 0, -1, 0},
{ 3, s_21_2, 0, -1, 0},
{ 3, s_21_3, 0, -1, 0},
{ 3, s_21_4, 0, -1, 0},
{ 3, s_21_5, 0, -1, 0},
{ 3, s_21_6, 0, -1, 0},
{ 3, s_21_7, 0, -1, 0}
};

static const symbol s_22_0[3] = { 'm', 'i', 0x15F };
static const symbol s_22_1[3] = { 'm', 'u', 0x15F };
static const symbol s_22_2[3] = { 'm', 0xFC, 0x15F };
static const symbol s_22_3[3] = { 'm', 0x131, 0x15F };
static const struct among a_22[4] = {
{ 3, s_22_0, 0, -1, 0},
{ 3, s_22_1, 0, -1, 0},
{ 3, s_22_2, 0, -1, 0},
{ 3, s_22_3, 0, -1, 0}
};

static const symbol s_23_0[1] = { 'b' };
static const symbol s_23_1[1] = { 'c' };
static const symbol s_23_2[1] = { 'd' };
static const symbol s_23_3[1] = { 0x11F };
static const struct among a_23[4] = {
{ 1, s_23_0, 0, 1, 0},
{ 1, s_23_1, 0, 2, 0},
{ 1, s_23_2, 0, 3, 0},
{ 1, s_23_3, 0, 4, 0}
};

static const unsigned char g_vowel[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 8, 0, 0, 0, 0, 0, 0, 1 };

static const unsigned char g_U[] = { 1, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 1 };

static const unsigned char g_vowel1[] = { 1, 64, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 };

static const unsigned char g_vowel2[] = { 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 130 };

static const unsigned char g_vowel3[] = { 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 };

static const unsigned char g_vowel4[] = { 17 };

static const unsigned char g_vowel5[] = { 65 };

static const unsigned char g_vowel6[] = { 65 };

static int r_check_vowel_harmony(struct SN_env * z) {
    {
        int v_1 = z->l - z->c;
        if (out_grouping_b(z, g_vowel, 97, 305, 1) < 0) return 0;
        do {
            int v_2 = z->l - z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 'a') goto lab0;
            z->c--;
            if (out_grouping_b(z, g_vowel1, 97, 305, 1) < 0) goto lab0;
            break;
        lab0:
            z->c = z->l - v_2;
            if (z->c <= z->lb || z->p[z->c - 1] != 'e') goto lab1;
            z->c--;
            if (out_grouping_b(z, g_vowel2, 101, 252, 1) < 0) goto lab1;
            break;
        lab1:
            z->c = z->l - v_2;
            if (z->c <= z->lb || z->p[z->c - 1] != 0x131) goto lab2;
            z->c--;
            if (out_grouping_b(z, g_vowel3, 97, 305, 1) < 0) goto lab2;
            break;
        lab2:
            z->c = z->l - v_2;
            if (z->c <= z->lb || z->p[z->c - 1] != 'i') goto lab3;
            z->c--;
            if (out_grouping_b(z, g_vowel4, 101, 105, 1) < 0) goto lab3;
            break;
        lab3:
            z->c = z->l - v_2;
            if (z->c <= z->lb || z->p[z->c - 1] != 'o') goto lab4;
            z->c--;
            if (out_grouping_b(z, g_vowel5, 111, 117, 1) < 0) goto lab4;
            break;
        lab4:
            z->c = z->l - v_2;
            if (z->c <= z->lb || z->p[z->c - 1] != 0xF6) goto lab5;
            z->c--;
            if (out_grouping_b(z, g_vowel6, 246, 252, 1) < 0) goto lab5;
            break;
        lab5:
            z->c = z->l - v_2;
            if (z->c <= z->lb || z->p[z->c - 1] != 'u') goto lab6;
            z->c--;
            if (out_grouping_b(z, g_vowel5, 111, 117, 1) < 0) goto lab6;
            break;
        lab6:
            z->c = z->l - v_2;
            if (z->c <= z->lb || z->p[z->c - 1] != 0xFC) return 0;
            z->c--;
            if (out_grouping_b(z, g_vowel6, 246, 252, 1) < 0) return 0;
        } while (0);
        z->c = z->l - v_1;
    }
    return 1;
}

static int r_1(struct SN_env * z) {
    do {
        int v_1 = z->l - z->c;
        if (z->c <= z->lb || z->p[z->c - 1] != 'n') goto lab0;
        z->c--;
        {
            int v_2 = z->l - z->c;
            if (in_grouping_b(z, g_vowel, 97, 305, 0)) goto lab0;
            z->c = z->l - v_2;
        }
        break;
    lab0:
        z->c = z->l - v_1;
        if (z->c <= z->lb || z->p[z->c - 1] != 'n') goto lab1;
        z->c--;
        return 0;
    lab1:
        {
            int v_3 = z->l - z->c;
            if (z->c <= z->lb) return 0;
            z->c--;
            if (in_grouping_b(z, g_vowel, 97, 305, 0)) return 0;
            z->c = z->l - v_3;
        }
    } while (0);
    return 1;
}

static int r_2(struct SN_env * z) {
    do {
        int v_1 = z->l - z->c;
        if (z->c <= z->lb || z->p[z->c - 1] != 'y') goto lab0;
        z->c--;
        {
            int v_2 = z->l - z->c;
            if (in_grouping_b(z, g_vowel, 97, 305, 0)) goto lab0;
            z->c = z->l - v_2;
        }
        break;
    lab0:
        z->c = z->l - v_1;
        if (z->c <= z->lb || z->p[z->c - 1] != 'y') goto lab1;
        z->c--;
        return 0;
    lab1:
        {
            int v_3 = z->l - z->c;
            if (z->c <= z->lb) return 0;
            z->c--;
            if (in_grouping_b(z, g_vowel, 97, 305, 0)) return 0;
            z->c = z->l - v_3;
        }
    } while (0);
    return 1;
}

static int r_mark_possessives(struct SN_env * z) {
    if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((67133440 >> (z->p[z->c - 1] & 0x1f)) & 1)) return 0;
    if (!find_among_b(z, a_0, 10, 0)) return 0;
    do {
        int v_1 = z->l - z->c;
        if (in_grouping_b(z, g_U, 105, 305, 0)) goto lab0;
        {
            int v_2 = z->l - z->c;
            if (out_grouping_b(z, g_vowel, 97, 305, 0)) goto lab0;
            z->c = z->l - v_2;
        }
        break;
    lab0:
        z->c = z->l - v_1;
        if (in_grouping_b(z, g_U, 105, 305, 0)) goto lab1;
        return 0;
    lab1:
        {
            int v_3 = z->l - z->c;
            if (z->c <= z->lb) return 0;
            z->c--;
            if (out_grouping_b(z, g_vowel, 97, 305, 0)) return 0;
            z->c = z->l - v_3;
        }
    } while (0);
    return 1;
}

static int r_mark_sU(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (in_grouping_b(z, g_U, 105, 305, 0)) return 0;
    do {
        int v_1 = z->l - z->c;
        if (z->c <= z->lb || z->p[z->c - 1] != 's') goto lab0;
        z->c--;
        {
            int v_2 = z->l - z->c;
            if (in_grouping_b(z, g_vowel, 97, 305, 0)) goto lab0;
            z->c = z->l - v_2;
        }
        break;
    lab0:
        z->c = z->l - v_1;
        if (z->c <= z->lb || z->p[z->c - 1] != 's') goto lab1;
        z->c--;
        return 0;
    lab1:
        {
            int v_3 = z->l - z->c;
            if (z->c <= z->lb) return 0;
            z->c--;
            if (in_grouping_b(z, g_vowel, 97, 305, 0)) return 0;
            z->c = z->l - v_3;
        }
    } while (0);
    return 1;
}

static int r_mark_lArI(struct SN_env * z) {
    if (z->c - 3 <= z->lb || (z->p[z->c - 1] != 105 && z->p[z->c - 1] != 305)) return 0;
    return find_among_b(z, a_1, 2, 0) != 0;
}

static int r_mark_nUn(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 1 <= z->lb || z->p[z->c - 1] != 110) return 0;
    if (!find_among_b(z, a_3, 4, 0)) return 0;
    return r_1(z);
}

static int r_mark_DA(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 101)) return 0;
    return find_among_b(z, a_6, 4, 0) != 0;
}

static int r_mark_ndA(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 2 <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 101)) return 0;
    return find_among_b(z, a_7, 2, 0) != 0;
}

static int r_mark_yUm(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 1 <= z->lb || z->p[z->c - 1] != 109) return 0;
    if (!find_among_b(z, a_12, 4, 0)) return 0;
    return r_2(z);
}

static int r_mark_sUn(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 2 <= z->lb || z->p[z->c - 1] != 110) return 0;
    return find_among_b(z, a_13, 4, 0) != 0;
}

static int r_mark_yUz(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 1 <= z->lb || z->p[z->c - 1] != 122) return 0;
    if (!find_among_b(z, a_14, 4, 0)) return 0;
    return r_2(z);
}

static int r_mark_sUnUz(struct SN_env * z) {
    if (z->c - 4 <= z->lb || z->p[z->c - 1] != 122) return 0;
    return find_among_b(z, a_15, 4, 0) != 0;
}

static int r_mark_lAr(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 2 <= z->lb || z->p[z->c - 1] != 114) return 0;
    return find_among_b(z, a_16, 2, 0) != 0;
}

static int r_mark_DUr(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 2 <= z->lb || z->p[z->c - 1] != 114) return 0;
    return find_among_b(z, a_18, 8, 0) != 0;
}

static int r_mark_yDU(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (!find_among_b(z, a_20, 32, 0)) return 0;
    return r_2(z);
}

static int r_mark_ysA(struct SN_env * z) {
    if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((26658 >> (z->p[z->c - 1] & 0x1f)) & 1)) return 0;
    if (!find_among_b(z, a_21, 8, 0)) return 0;
    return r_2(z);
}

static int r_mark_ymUs_(struct SN_env * z) {
    {
        int ret = r_check_vowel_harmony(z);
        if (ret == 0) return ret;
    }
    if (z->c - 2 <= z->lb || z->p[z->c - 1] != 351) return 0;
    if (!find_among_b(z, a_22, 4, 0)) return 0;
    return r_2(z);
}

static int r_stem_suffix_chain_before_ki(struct SN_env * z) {
    z->ket = z->c;
    if (!(eq_s_b(z, 2, s_0))) return 0;
    do {
        int v_1 = z->l - z->c;
        if (!r_mark_DA(z)) goto lab0;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        {
            int v_2 = z->l - z->c;
            z->ket = z->c;
            do {
                int v_3 = z->l - z->c;
                if (!r_mark_lAr(z)) goto lab2;
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int v_4 = z->l - z->c;
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_4; goto lab3; }
                        if (ret < 0) return ret;
                    }
                lab3:
                    ;
                }
                break;
            lab2:
                z->c = z->l - v_3;
                if (!r_mark_possessives(z)) { z->c = z->l - v_2; goto lab1; }
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int v_5 = z->l - z->c;
                    z->ket = z->c;
                    if (!r_mark_lAr(z)) { z->c = z->l - v_5; goto lab4; }
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_5; goto lab4; }
                        if (ret < 0) return ret;
                    }
                lab4:
                    ;
                }
            } while (0);
        lab1:
            ;
        }
        break;
    lab0:
        z->c = z->l - v_1;
        if (!r_mark_nUn(z)) goto lab5;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        {
            int v_6 = z->l - z->c;
            z->ket = z->c;
            do {
                int v_7 = z->l - z->c;
                if (!r_mark_lArI(z)) goto lab7;
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            lab7:
                z->c = z->l - v_7;
                z->ket = z->c;
                do {
                    int v_8 = z->l - z->c;
                    if (!r_mark_possessives(z)) goto lab9;
                    break;
                lab9:
                    z->c = z->l - v_8;
                    if (!r_mark_sU(z)) goto lab8;
                } while (0);
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int v_9 = z->l - z->c;
                    z->ket = z->c;
                    if (!r_mark_lAr(z)) { z->c = z->l - v_9; goto lab10; }
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_9; goto lab10; }
                        if (ret < 0) return ret;
                    }
                lab10:
                    ;
                }
                break;
            lab8:
                z->c = z->l - v_7;
                {
                    int ret = r_stem_suffix_chain_before_ki(z);
                    if (ret == 0) { z->c = z->l - v_6; goto lab6; }
                    if (ret < 0) return ret;
                }
            } while (0);
        lab6:
            ;
        }
        break;
    lab5:
        z->c = z->l - v_1;
        {
            int ret = r_mark_ndA(z);
            if (ret == 0) return ret;
        }
        do {
            int v_10 = z->l - z->c;
            if (!r_mark_lArI(z)) goto lab11;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        lab11:
            z->c = z->l - v_10;
            if (!r_mark_sU(z)) goto lab12;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_11 = z->l - z->c;
                z->ket = z->c;
                if (!r_mark_lAr(z)) { z->c = z->l - v_11; goto lab13; }
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int ret = r_stem_suffix_chain_before_ki(z);
                    if (ret == 0) { z->c = z->l - v_11; goto lab13; }
                    if (ret < 0) return ret;
                }
            lab13:
                ;
            }
            break;
        lab12:
            z->c = z->l - v_10;
            {
                int ret = r_stem_suffix_chain_before_ki(z);
                if (ret <= 0) return ret;
            }
        } while (0);
    } while (0);
    return 1;
}

extern int turkish_stem(struct SN_env * z) {
    int among_var;
    int b_0;
    {
        int v_1 = z->c;
        z->bra = z->c;
        while (1) {
            int v_2 = z->c;
            if (z->c == z->l || z->p[z->c] != '\'') goto lab3;
            z->c++;
            goto lab2;
        lab3:
            z->c = v_2;
            break;
        lab2:
            z->c = v_2;
            if (z->c >= z->l) goto lab1;
            z->c++;
        }
        z->ket = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab1:
        z->c = v_1;
    }
    {
        int v_3 = z->c;
        if (z->c + 2 > z->l) goto lab4;
        z->c += 2;
        while (1) {
            int v_4 = z->c;
            if (z->c == z->l || z->p[z->c] != '\'') goto lab5;
            z->c++;
            z->c = v_4;
            break;
        lab5:
            z->c = v_4;
            if (z->c >= z->l) goto lab4;
            z->c++;
        }
        z->bra = z->c;
        z->c = z->l;
        z->ket = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab4:
        z->c = v_3;
    }
    {
        int v_5 = z->c;
        {
            int i; for (i = 2; i > 0; i--) {
                {
                    int ret = out_grouping(z, g_vowel, 97, 305, 1);
                    if (ret < 0) return 0;
                    z->c += ret;
                }
            }
        }
        z->c = v_5;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_6 = z->l - z->c;
        z->ket = z->c;
        b_0 = 1;
        do {
            int v_7 = z->l - z->c;
            do {
                int v_8 = z->l - z->c;
                if (!r_mark_ymUs_(z)) goto lab8;
                break;
            lab8:
                z->c = z->l - v_8;
                if (!r_mark_yDU(z)) goto lab9;
                break;
            lab9:
                z->c = z->l - v_8;
                if (!r_mark_ysA(z)) goto lab10;
                break;
            lab10:
                z->c = z->l - v_8;
                if (!(eq_s_b(z, 3, s_1))) goto lab7;
                if (!r_2(z)) goto lab7;
            } while (0);
            break;
        lab7:
            z->c = z->l - v_7;
            if (z->c - 5 <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 101)) goto lab11;
            if (!find_among_b(z, a_19, 2, 0)) goto lab11;
            do {
                int v_9 = z->l - z->c;
                if (!r_mark_sUnUz(z)) goto lab12;
                break;
            lab12:
                z->c = z->l - v_9;
                if (!r_mark_lAr(z)) goto lab13;
                break;
            lab13:
                z->c = z->l - v_9;
                if (!r_mark_yUm(z)) goto lab14;
                break;
            lab14:
                z->c = z->l - v_9;
                if (!r_mark_sUn(z)) goto lab15;
                break;
            lab15:
                z->c = z->l - v_9;
                if (!r_mark_yUz(z)) goto lab16;
                break;
            lab16:
                z->c = z->l - v_9;
            } while (0);
            if (!r_mark_ymUs_(z)) goto lab11;
            break;
        lab11:
            z->c = z->l - v_7;
            if (!r_mark_lAr(z)) goto lab17;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_10 = z->l - z->c;
                z->ket = z->c;
                do {
                    int v_11 = z->l - z->c;
                    if (!r_mark_DUr(z)) goto lab19;
                    break;
                lab19:
                    z->c = z->l - v_11;
                    if (!r_mark_yDU(z)) goto lab20;
                    break;
                lab20:
                    z->c = z->l - v_11;
                    if (!r_mark_ysA(z)) goto lab21;
                    break;
                lab21:
                    z->c = z->l - v_11;
                    if (!r_mark_ymUs_(z)) { z->c = z->l - v_10; goto lab18; }
                } while (0);
            lab18:
                ;
            }
            b_0 = 0;
            break;
        lab17:
            z->c = z->l - v_7;
            if (!r_check_vowel_harmony(z)) goto lab22;
            if (z->c - 2 <= z->lb || z->p[z->c - 1] != 122) goto lab22;
            if (!find_among_b(z, a_17, 4, 0)) goto lab22;
            do {
                int v_12 = z->l - z->c;
                if (!r_mark_yDU(z)) goto lab23;
                break;
            lab23:
                z->c = z->l - v_12;
                if (!r_mark_ysA(z)) goto lab22;
            } while (0);
            break;
        lab22:
            z->c = z->l - v_7;
            do {
                int v_13 = z->l - z->c;
                if (!r_mark_sUnUz(z)) goto lab25;
                break;
            lab25:
                z->c = z->l - v_13;
                if (!r_mark_yUz(z)) goto lab26;
                break;
            lab26:
                z->c = z->l - v_13;
                if (!r_mark_sUn(z)) goto lab27;
                break;
            lab27:
                z->c = z->l - v_13;
                if (!r_mark_yUm(z)) goto lab24;
            } while (0);
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_14 = z->l - z->c;
                z->ket = z->c;
                if (!r_mark_ymUs_(z)) { z->c = z->l - v_14; goto lab28; }
            lab28:
                ;
            }
            break;
        lab24:
            z->c = z->l - v_7;
            if (!r_mark_DUr(z)) goto lab6;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_15 = z->l - z->c;
                z->ket = z->c;
                do {
                    int v_16 = z->l - z->c;
                    if (!r_mark_sUnUz(z)) goto lab30;
                    break;
                lab30:
                    z->c = z->l - v_16;
                    if (!r_mark_lAr(z)) goto lab31;
                    break;
                lab31:
                    z->c = z->l - v_16;
                    if (!r_mark_yUm(z)) goto lab32;
                    break;
                lab32:
                    z->c = z->l - v_16;
                    if (!r_mark_sUn(z)) goto lab33;
                    break;
                lab33:
                    z->c = z->l - v_16;
                    if (!r_mark_yUz(z)) goto lab34;
                    break;
                lab34:
                    z->c = z->l - v_16;
                } while (0);
                if (!r_mark_ymUs_(z)) { z->c = z->l - v_15; goto lab29; }
            lab29:
                ;
            }
        } while (0);
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab6:
        z->c = z->l - v_6;
    }
    if (!b_0) return 0;
    {
        int v_17 = z->l - z->c;
        do {
            int v_18 = z->l - z->c;
            z->ket = z->c;
            if (!r_mark_lAr(z)) goto lab36;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_19 = z->l - z->c;
                {
                    int ret = r_stem_suffix_chain_before_ki(z);
                    if (ret == 0) { z->c = z->l - v_19; goto lab37; }
                    if (ret < 0) return ret;
                }
            lab37:
                ;
            }
            break;
        lab36:
            z->c = z->l - v_18;
            z->ket = z->c;
            if (!r_check_vowel_harmony(z)) goto lab38;
            if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 101)) goto lab38;
            if (!find_among_b(z, a_11, 2, 0)) goto lab38;
            if (!r_1(z)) goto lab38;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_20 = z->l - z->c;
                do {
                    int v_21 = z->l - z->c;
                    z->ket = z->c;
                    if (!r_mark_lArI(z)) goto lab40;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab40:
                    z->c = z->l - v_21;
                    z->ket = z->c;
                    do {
                        int v_22 = z->l - z->c;
                        if (!r_mark_possessives(z)) goto lab42;
                        break;
                    lab42:
                        z->c = z->l - v_22;
                        if (!r_mark_sU(z)) goto lab41;
                    } while (0);
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_23 = z->l - z->c;
                        z->ket = z->c;
                        if (!r_mark_lAr(z)) { z->c = z->l - v_23; goto lab43; }
                        z->bra = z->c;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        {
                            int ret = r_stem_suffix_chain_before_ki(z);
                            if (ret == 0) { z->c = z->l - v_23; goto lab43; }
                            if (ret < 0) return ret;
                        }
                    lab43:
                        ;
                    }
                    break;
                lab41:
                    z->c = z->l - v_21;
                    z->ket = z->c;
                    if (!r_mark_lAr(z)) { z->c = z->l - v_20; goto lab39; }
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_20; goto lab39; }
                        if (ret < 0) return ret;
                    }
                } while (0);
            lab39:
                ;
            }
            break;
        lab38:
            z->c = z->l - v_18;
            z->ket = z->c;
            do {
                int v_24 = z->l - z->c;
                if (!r_mark_ndA(z)) goto lab45;
                break;
            lab45:
                z->c = z->l - v_24;
                if (!r_check_vowel_harmony(z)) goto lab44;
                if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 101)) goto lab44;
                if (!find_among_b(z, a_5, 2, 0)) goto lab44;
            } while (0);
            do {
                int v_25 = z->l - z->c;
                if (!r_mark_lArI(z)) goto lab46;
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            lab46:
                z->c = z->l - v_25;
                if (!r_mark_sU(z)) goto lab47;
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int v_26 = z->l - z->c;
                    z->ket = z->c;
                    if (!r_mark_lAr(z)) { z->c = z->l - v_26; goto lab48; }
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_26; goto lab48; }
                        if (ret < 0) return ret;
                    }
                lab48:
                    ;
                }
                break;
            lab47:
                z->c = z->l - v_25;
                {
                    int ret = r_stem_suffix_chain_before_ki(z);
                    if (ret == 0) goto lab44;
                    if (ret < 0) return ret;
                }
            } while (0);
            break;
        lab44:
            z->c = z->l - v_18;
            z->ket = z->c;
            do {
                int v_27 = z->l - z->c;
                if (!r_check_vowel_harmony(z)) goto lab50;
                if (z->c - 3 <= z->lb || z->p[z->c - 1] != 110) goto lab50;
                if (!find_among_b(z, a_9, 2, 0)) goto lab50;
                break;
            lab50:
                z->c = z->l - v_27;
                if (!r_check_vowel_harmony(z)) goto lab49;
                if (!find_among_b(z, a_2, 4, 0)) goto lab49;
            } while (0);
            do {
                int v_28 = z->l - z->c;
                if (!r_mark_sU(z)) goto lab51;
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int v_29 = z->l - z->c;
                    z->ket = z->c;
                    if (!r_mark_lAr(z)) { z->c = z->l - v_29; goto lab52; }
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_29; goto lab52; }
                        if (ret < 0) return ret;
                    }
                lab52:
                    ;
                }
                break;
            lab51:
                z->c = z->l - v_28;
                if (!r_mark_lArI(z)) goto lab49;
            } while (0);
            break;
        lab49:
            z->c = z->l - v_18;
            z->ket = z->c;
            if (!r_check_vowel_harmony(z)) goto lab53;
            if (z->c - 2 <= z->lb || z->p[z->c - 1] != 110) goto lab53;
            if (!find_among_b(z, a_8, 4, 0)) goto lab53;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_30 = z->l - z->c;
                z->ket = z->c;
                do {
                    int v_31 = z->l - z->c;
                    if (!r_mark_possessives(z)) goto lab55;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_32 = z->l - z->c;
                        z->ket = z->c;
                        if (!r_mark_lAr(z)) { z->c = z->l - v_32; goto lab56; }
                        z->bra = z->c;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        {
                            int ret = r_stem_suffix_chain_before_ki(z);
                            if (ret == 0) { z->c = z->l - v_32; goto lab56; }
                            if (ret < 0) return ret;
                        }
                    lab56:
                        ;
                    }
                    break;
                lab55:
                    z->c = z->l - v_31;
                    if (!r_mark_lAr(z)) goto lab57;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_33 = z->l - z->c;
                        {
                            int ret = r_stem_suffix_chain_before_ki(z);
                            if (ret == 0) { z->c = z->l - v_33; goto lab58; }
                            if (ret < 0) return ret;
                        }
                    lab58:
                        ;
                    }
                    break;
                lab57:
                    z->c = z->l - v_31;
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_30; goto lab54; }
                        if (ret < 0) return ret;
                    }
                } while (0);
            lab54:
                ;
            }
            break;
        lab53:
            z->c = z->l - v_18;
            z->ket = z->c;
            do {
                int v_34 = z->l - z->c;
                if (!r_mark_nUn(z)) goto lab60;
                break;
            lab60:
                z->c = z->l - v_34;
                if (!r_check_vowel_harmony(z)) goto lab59;
                if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 101)) goto lab59;
                if (!find_among_b(z, a_10, 2, 0)) goto lab59;
                if (!r_2(z)) goto lab59;
            } while (0);
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_35 = z->l - z->c;
                do {
                    int v_36 = z->l - z->c;
                    z->ket = z->c;
                    if (!r_mark_lAr(z)) goto lab62;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) goto lab62;
                        if (ret < 0) return ret;
                    }
                    break;
                lab62:
                    z->c = z->l - v_36;
                    z->ket = z->c;
                    do {
                        int v_37 = z->l - z->c;
                        if (!r_mark_possessives(z)) goto lab64;
                        break;
                    lab64:
                        z->c = z->l - v_37;
                        if (!r_mark_sU(z)) goto lab63;
                    } while (0);
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_38 = z->l - z->c;
                        z->ket = z->c;
                        if (!r_mark_lAr(z)) { z->c = z->l - v_38; goto lab65; }
                        z->bra = z->c;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        {
                            int ret = r_stem_suffix_chain_before_ki(z);
                            if (ret == 0) { z->c = z->l - v_38; goto lab65; }
                            if (ret < 0) return ret;
                        }
                    lab65:
                        ;
                    }
                    break;
                lab63:
                    z->c = z->l - v_36;
                    {
                        int ret = r_stem_suffix_chain_before_ki(z);
                        if (ret == 0) { z->c = z->l - v_35; goto lab61; }
                        if (ret < 0) return ret;
                    }
                } while (0);
            lab61:
                ;
            }
            break;
        lab59:
            z->c = z->l - v_18;
            z->ket = z->c;
            if (!r_mark_lArI(z)) goto lab66;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        lab66:
            z->c = z->l - v_18;
            {
                int ret = r_stem_suffix_chain_before_ki(z);
                if (ret == 0) goto lab67;
                if (ret < 0) return ret;
            }
            break;
        lab67:
            z->c = z->l - v_18;
            z->ket = z->c;
            do {
                int v_39 = z->l - z->c;
                if (!r_mark_DA(z)) goto lab69;
                break;
            lab69:
                z->c = z->l - v_39;
                if (!r_check_vowel_harmony(z)) goto lab70;
                if (in_grouping_b(z, g_U, 105, 305, 0)) goto lab70;
                if (!r_2(z)) goto lab70;
                break;
            lab70:
                z->c = z->l - v_39;
                if (!r_check_vowel_harmony(z)) goto lab68;
                if (z->c <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 101)) goto lab68;
                z->c--;
                if (!r_2(z)) goto lab68;
            } while (0);
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_40 = z->l - z->c;
                z->ket = z->c;
                do {
                    int v_41 = z->l - z->c;
                    if (!r_mark_possessives(z)) goto lab72;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_42 = z->l - z->c;
                        z->ket = z->c;
                        if (!r_mark_lAr(z)) { z->c = z->l - v_42; goto lab73; }
                    lab73:
                        ;
                    }
                    break;
                lab72:
                    z->c = z->l - v_41;
                    if (!r_mark_lAr(z)) { z->c = z->l - v_40; goto lab71; }
                } while (0);
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                z->ket = z->c;
                {
                    int ret = r_stem_suffix_chain_before_ki(z);
                    if (ret == 0) { z->c = z->l - v_40; goto lab71; }
                    if (ret < 0) return ret;
                }
            lab71:
                ;
            }
            break;
        lab68:
            z->c = z->l - v_18;
            z->ket = z->c;
            do {
                int v_43 = z->l - z->c;
                if (!r_mark_possessives(z)) goto lab74;
                break;
            lab74:
                z->c = z->l - v_43;
                if (!r_mark_sU(z)) goto lab35;
            } while (0);
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_44 = z->l - z->c;
                z->ket = z->c;
                if (!r_mark_lAr(z)) { z->c = z->l - v_44; goto lab75; }
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int ret = r_stem_suffix_chain_before_ki(z);
                    if (ret == 0) { z->c = z->l - v_44; goto lab75; }
                    if (ret < 0) return ret;
                }
            lab75:
                ;
            }
        } while (0);
    lab35:
        z->c = z->l - v_17;
    }
    z->c = z->lb;
    z->lb = z->c; z->c = z->l;
    {
        int v_45 = z->l - z->c;
        if (!(eq_s_b(z, 2, s_2))) goto lab76;
        {
            int v_46 = z->l - z->c;
            if (!(eq_s_b(z, 3, s_3))) { z->c = z->l - v_46; goto lab77; }
        lab77:
            ;
        }
        if (z->c > z->lb) goto lab76;
        return 0;
    lab76:
        z->c = z->l - v_45;
    }
    {
        int v_47 = z->l - z->c;
        z->ket = z->c;
        z->bra = z->c;
        do {
            if (z->c <= z->lb || z->p[z->c - 1] != 'd') goto lab79;
            z->c--;
            break;
        lab79:
            if (z->c <= z->lb || z->p[z->c - 1] != 'g') goto lab78;
            z->c--;
        } while (0);
        if (out_grouping_b(z, g_vowel, 97, 305, 1) < 0) goto lab78;
        do {
            int v_48 = z->l - z->c;
            do {
                if (z->c <= z->lb || z->p[z->c - 1] != 'a') goto lab81;
                z->c--;
                break;
            lab81:
                if (z->c <= z->lb || z->p[z->c - 1] != 0x131) goto lab80;
                z->c--;
            } while (0);
            {
                int ret = slice_from_s(z, 1, s_4);
                if (ret < 0) return ret;
            }
            break;
        lab80:
            z->c = z->l - v_48;
            do {
                if (z->c <= z->lb || z->p[z->c - 1] != 'e') goto lab83;
                z->c--;
                break;
            lab83:
                if (z->c <= z->lb || z->p[z->c - 1] != 'i') goto lab82;
                z->c--;
            } while (0);
            {
                int ret = slice_from_s(z, 1, s_5);
                if (ret < 0) return ret;
            }
            break;
        lab82:
            z->c = z->l - v_48;
            do {
                if (z->c <= z->lb || z->p[z->c - 1] != 'o') goto lab85;
                z->c--;
                break;
            lab85:
                if (z->c <= z->lb || z->p[z->c - 1] != 'u') goto lab84;
                z->c--;
            } while (0);
            {
                int ret = slice_from_s(z, 1, s_6);
                if (ret < 0) return ret;
            }
            break;
        lab84:
            z->c = z->l - v_48;
            do {
                if (z->c <= z->lb || z->p[z->c - 1] != 0xF6) goto lab86;
                z->c--;
                break;
            lab86:
                if (z->c <= z->lb || z->p[z->c - 1] != 0xFC) goto lab78;
                z->c--;
            } while (0);
            {
                int ret = slice_from_s(z, 1, s_7);
                if (ret < 0) return ret;
            }
        } while (0);
    lab78:
        z->c = z->l - v_47;
    }
    {
        int v_49 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_23, 4, 0);
        if (!among_var) goto lab87;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_8);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_9);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_10);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 1, s_11);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab87:
        z->c = z->l - v_49;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * turkish_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
