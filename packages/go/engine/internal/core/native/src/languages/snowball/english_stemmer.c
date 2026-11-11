/*
 * Generated from algorithms/english.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "english_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int english_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_shortv(struct SN_env * z);

static const symbol s_0[] = { 'p', 'a', 's', 't' };
static const symbol s_1[] = { 's', 'k', 'i' };
static const symbol s_2[] = { 's', 'k', 'y' };
static const symbol s_3[] = { 'i', 'd', 'l' };
static const symbol s_4[] = { 'g', 'e', 'n', 't', 'l' };
static const symbol s_5[] = { 'u', 'g', 'l', 'i' };
static const symbol s_6[] = { 'e', 'a', 'r', 'l', 'i' };
static const symbol s_7[] = { 'o', 'n', 'l', 'i' };
static const symbol s_8[] = { 's', 'i', 'n', 'g', 'l' };
static const symbol s_9[] = { 'Y' };
static const symbol s_10[] = { 'Y' };
static const symbol s_11[] = { 's', 's' };
static const symbol s_12[] = { 'i' };
static const symbol s_13[] = { 'i', 'e' };
static const symbol s_14[] = { 'e', 'e' };
static const symbol s_15[] = { 'i', 'e' };
static const symbol s_16[] = { 'e' };
static const symbol s_17[] = { 'e' };
static const symbol s_18[] = { 'i' };
static const symbol s_19[] = { 't', 'i', 'o', 'n' };
static const symbol s_20[] = { 'e', 'n', 'c', 'e' };
static const symbol s_21[] = { 'a', 'n', 'c', 'e' };
static const symbol s_22[] = { 'a', 'b', 'l', 'e' };
static const symbol s_23[] = { 'e', 'n', 't' };
static const symbol s_24[] = { 'i', 'z', 'e' };
static const symbol s_25[] = { 'a', 't', 'e' };
static const symbol s_26[] = { 'a', 'l' };
static const symbol s_27[] = { 'f', 'u', 'l' };
static const symbol s_28[] = { 'o', 'u', 's' };
static const symbol s_29[] = { 'i', 'v', 'e' };
static const symbol s_30[] = { 'b', 'l', 'e' };
static const symbol s_31[] = { 'o', 'g' };
static const symbol s_32[] = { 'o', 'g' };
static const symbol s_33[] = { 'l', 'e', 's', 's' };
static const symbol s_34[] = { 't', 'i', 'o', 'n' };
static const symbol s_35[] = { 'a', 't', 'e' };
static const symbol s_36[] = { 'a', 'l' };
static const symbol s_37[] = { 'i', 'c' };
static const symbol s_38[] = { 'y' };

static const symbol s_0_0[5] = { 'a', 'r', 's', 'e', 'n' };
static const symbol s_0_1[6] = { 'c', 'o', 'm', 'm', 'u', 'n' };
static const symbol s_0_2[5] = { 'e', 'm', 'e', 'r', 'g' };
static const symbol s_0_3[5] = { 'g', 'e', 'n', 'e', 'r' };
static const symbol s_0_4[5] = { 'i', 'n', 't', 'e', 'r' };
static const symbol s_0_5[5] = { 'l', 'a', 't', 'e', 'r' };
static const symbol s_0_6[5] = { 'o', 'r', 'g', 'a', 'n' };
static const symbol s_0_7[4] = { 'p', 'a', 's', 't' };
static const symbol s_0_8[7] = { 'u', 'n', 'i', 'v', 'e', 'r', 's' };
static const struct among a_0[9] = {
{ 5, s_0_0, 0, -1, 0},
{ 6, s_0_1, 0, -1, 0},
{ 5, s_0_2, 0, -1, 0},
{ 5, s_0_3, 0, -1, 0},
{ 5, s_0_4, 0, -1, 0},
{ 5, s_0_5, 0, -1, 0},
{ 5, s_0_6, 0, -1, 0},
{ 4, s_0_7, 0, -1, 0},
{ 7, s_0_8, 0, -1, 0}
};

static const symbol s_1_0[1] = { '\'' };
static const symbol s_1_1[3] = { '\'', 's', '\'' };
static const symbol s_1_2[2] = { '\'', 's' };
static const struct among a_1[3] = {
{ 1, s_1_0, 0, 1, 0},
{ 3, s_1_1, -1, 1, 0},
{ 2, s_1_2, 0, 1, 0}
};

static const symbol s_2_0[3] = { 'i', 'e', 'd' };
static const symbol s_2_1[1] = { 's' };
static const symbol s_2_2[3] = { 'i', 'e', 's' };
static const symbol s_2_3[4] = { 's', 's', 'e', 's' };
static const symbol s_2_4[2] = { 's', 's' };
static const symbol s_2_5[2] = { 'u', 's' };
static const struct among a_2[6] = {
{ 3, s_2_0, 0, 2, 0},
{ 1, s_2_1, 0, 3, 0},
{ 3, s_2_2, -1, 2, 0},
{ 4, s_2_3, -2, 1, 0},
{ 2, s_2_4, -3, -1, 0},
{ 2, s_2_5, -4, -1, 0}
};

static const symbol s_3_0[4] = { 's', 'u', 'c', 'c' };
static const symbol s_3_1[4] = { 'p', 'r', 'o', 'c' };
static const symbol s_3_2[3] = { 'e', 'x', 'c' };
static const struct among a_3[3] = {
{ 4, s_3_0, 0, 1, 0},
{ 4, s_3_1, 0, 1, 0},
{ 3, s_3_2, 0, 1, 0}
};

static const symbol s_4_0[4] = { 'e', 'v', 'e', 'n' };
static const symbol s_4_1[4] = { 'c', 'a', 'n', 'n' };
static const symbol s_4_2[3] = { 'i', 'n', 'n' };
static const symbol s_4_3[4] = { 'e', 'a', 'r', 'r' };
static const symbol s_4_4[4] = { 'h', 'e', 'r', 'r' };
static const symbol s_4_5[3] = { 'o', 'u', 't' };
static const symbol s_4_6[1] = { 'y' };
static const struct among a_4[7] = {
{ 4, s_4_0, 0, 2, 0},
{ 4, s_4_1, 0, 2, 0},
{ 3, s_4_2, 0, 2, 0},
{ 4, s_4_3, 0, 2, 0},
{ 4, s_4_4, 0, 2, 0},
{ 3, s_4_5, 0, 2, 0},
{ 1, s_4_6, 0, 1, 0}
};

static const symbol s_5_1[2] = { 'e', 'd' };
static const symbol s_5_2[3] = { 'e', 'e', 'd' };
static const symbol s_5_3[3] = { 'i', 'n', 'g' };
static const symbol s_5_4[4] = { 'e', 'd', 'l', 'y' };
static const symbol s_5_5[5] = { 'e', 'e', 'd', 'l', 'y' };
static const symbol s_5_6[5] = { 'i', 'n', 'g', 'l', 'y' };
static const struct among a_5[7] = {
{ 0, 0, 0, -1, 0},
{ 2, s_5_1, -1, 2, 0},
{ 3, s_5_2, -1, 1, 0},
{ 3, s_5_3, -3, 3, 0},
{ 4, s_5_4, -4, 2, 0},
{ 5, s_5_5, -1, 1, 0},
{ 5, s_5_6, -6, 2, 0}
};

static const symbol s_6_1[2] = { 'b', 'b' };
static const symbol s_6_2[2] = { 'd', 'd' };
static const symbol s_6_3[2] = { 'f', 'f' };
static const symbol s_6_4[2] = { 'g', 'g' };
static const symbol s_6_5[2] = { 'b', 'l' };
static const symbol s_6_6[2] = { 'm', 'm' };
static const symbol s_6_7[2] = { 'n', 'n' };
static const symbol s_6_8[2] = { 'p', 'p' };
static const symbol s_6_9[2] = { 'r', 'r' };
static const symbol s_6_10[2] = { 'a', 't' };
static const symbol s_6_11[2] = { 't', 't' };
static const symbol s_6_12[2] = { 'i', 'z' };
static const struct among a_6[13] = {
{ 0, 0, 0, 3, 0},
{ 2, s_6_1, -1, 2, 0},
{ 2, s_6_2, -2, 2, 0},
{ 2, s_6_3, -3, 2, 0},
{ 2, s_6_4, -4, 2, 0},
{ 2, s_6_5, -5, 1, 0},
{ 2, s_6_6, -6, 2, 0},
{ 2, s_6_7, -7, 2, 0},
{ 2, s_6_8, -8, 2, 0},
{ 2, s_6_9, -9, 2, 0},
{ 2, s_6_10, -10, 1, 0},
{ 2, s_6_11, -11, 2, 0},
{ 2, s_6_12, -12, 1, 0}
};

static const symbol s_7_0[4] = { 'a', 'n', 'c', 'i' };
static const symbol s_7_1[4] = { 'e', 'n', 'c', 'i' };
static const symbol s_7_2[3] = { 'o', 'g', 'i' };
static const symbol s_7_3[2] = { 'l', 'i' };
static const symbol s_7_4[3] = { 'b', 'l', 'i' };
static const symbol s_7_5[4] = { 'a', 'b', 'l', 'i' };
static const symbol s_7_6[4] = { 'a', 'l', 'l', 'i' };
static const symbol s_7_7[5] = { 'f', 'u', 'l', 'l', 'i' };
static const symbol s_7_8[6] = { 'l', 'e', 's', 's', 'l', 'i' };
static const symbol s_7_9[5] = { 'o', 'u', 's', 'l', 'i' };
static const symbol s_7_10[5] = { 'e', 'n', 't', 'l', 'i' };
static const symbol s_7_11[5] = { 'a', 'l', 'i', 't', 'i' };
static const symbol s_7_12[6] = { 'b', 'i', 'l', 'i', 't', 'i' };
static const symbol s_7_13[5] = { 'i', 'v', 'i', 't', 'i' };
static const symbol s_7_14[6] = { 't', 'i', 'o', 'n', 'a', 'l' };
static const symbol s_7_15[7] = { 'a', 't', 'i', 'o', 'n', 'a', 'l' };
static const symbol s_7_16[5] = { 'a', 'l', 'i', 's', 'm' };
static const symbol s_7_17[5] = { 'a', 't', 'i', 'o', 'n' };
static const symbol s_7_18[7] = { 'i', 'z', 'a', 't', 'i', 'o', 'n' };
static const symbol s_7_19[4] = { 'i', 'z', 'e', 'r' };
static const symbol s_7_20[4] = { 'a', 't', 'o', 'r' };
static const symbol s_7_21[7] = { 'i', 'v', 'e', 'n', 'e', 's', 's' };
static const symbol s_7_22[7] = { 'f', 'u', 'l', 'n', 'e', 's', 's' };
static const symbol s_7_23[7] = { 'o', 'u', 's', 'n', 'e', 's', 's' };
static const symbol s_7_24[5] = { 'o', 'g', 'i', 's', 't' };
static const struct among a_7[25] = {
{ 4, s_7_0, 0, 3, 0},
{ 4, s_7_1, 0, 2, 0},
{ 3, s_7_2, 0, 14, 0},
{ 2, s_7_3, 0, 16, 0},
{ 3, s_7_4, -1, 12, 0},
{ 4, s_7_5, -1, 4, 0},
{ 4, s_7_6, -3, 8, 0},
{ 5, s_7_7, -4, 9, 0},
{ 6, s_7_8, -5, 15, 0},
{ 5, s_7_9, -6, 10, 0},
{ 5, s_7_10, -7, 5, 0},
{ 5, s_7_11, 0, 8, 0},
{ 6, s_7_12, 0, 12, 0},
{ 5, s_7_13, 0, 11, 0},
{ 6, s_7_14, 0, 1, 0},
{ 7, s_7_15, -1, 7, 0},
{ 5, s_7_16, 0, 8, 0},
{ 5, s_7_17, 0, 7, 0},
{ 7, s_7_18, -1, 6, 0},
{ 4, s_7_19, 0, 6, 0},
{ 4, s_7_20, 0, 7, 0},
{ 7, s_7_21, 0, 11, 0},
{ 7, s_7_22, 0, 9, 0},
{ 7, s_7_23, 0, 10, 0},
{ 5, s_7_24, 0, 13, 0}
};

static const symbol s_8_0[5] = { 'i', 'c', 'a', 't', 'e' };
static const symbol s_8_1[5] = { 'a', 't', 'i', 'v', 'e' };
static const symbol s_8_2[5] = { 'a', 'l', 'i', 'z', 'e' };
static const symbol s_8_3[5] = { 'i', 'c', 'i', 't', 'i' };
static const symbol s_8_4[4] = { 'i', 'c', 'a', 'l' };
static const symbol s_8_5[6] = { 't', 'i', 'o', 'n', 'a', 'l' };
static const symbol s_8_6[7] = { 'a', 't', 'i', 'o', 'n', 'a', 'l' };
static const symbol s_8_7[3] = { 'f', 'u', 'l' };
static const symbol s_8_8[4] = { 'n', 'e', 's', 's' };
static const struct among a_8[9] = {
{ 5, s_8_0, 0, 4, 0},
{ 5, s_8_1, 0, 6, 0},
{ 5, s_8_2, 0, 3, 0},
{ 5, s_8_3, 0, 4, 0},
{ 4, s_8_4, 0, 4, 0},
{ 6, s_8_5, 0, 1, 0},
{ 7, s_8_6, -1, 2, 0},
{ 3, s_8_7, 0, 5, 0},
{ 4, s_8_8, 0, 5, 0}
};

static const symbol s_9_0[2] = { 'i', 'c' };
static const symbol s_9_1[4] = { 'a', 'n', 'c', 'e' };
static const symbol s_9_2[4] = { 'e', 'n', 'c', 'e' };
static const symbol s_9_3[4] = { 'a', 'b', 'l', 'e' };
static const symbol s_9_4[4] = { 'i', 'b', 'l', 'e' };
static const symbol s_9_5[3] = { 'a', 't', 'e' };
static const symbol s_9_6[3] = { 'i', 'v', 'e' };
static const symbol s_9_7[3] = { 'i', 'z', 'e' };
static const symbol s_9_8[3] = { 'i', 't', 'i' };
static const symbol s_9_9[2] = { 'a', 'l' };
static const symbol s_9_10[3] = { 'i', 's', 'm' };
static const symbol s_9_11[3] = { 'i', 'o', 'n' };
static const symbol s_9_12[2] = { 'e', 'r' };
static const symbol s_9_13[3] = { 'o', 'u', 's' };
static const symbol s_9_14[3] = { 'a', 'n', 't' };
static const symbol s_9_15[3] = { 'e', 'n', 't' };
static const symbol s_9_16[4] = { 'm', 'e', 'n', 't' };
static const symbol s_9_17[5] = { 'e', 'm', 'e', 'n', 't' };
static const struct among a_9[18] = {
{ 2, s_9_0, 0, 1, 0},
{ 4, s_9_1, 0, 1, 0},
{ 4, s_9_2, 0, 1, 0},
{ 4, s_9_3, 0, 1, 0},
{ 4, s_9_4, 0, 1, 0},
{ 3, s_9_5, 0, 1, 0},
{ 3, s_9_6, 0, 1, 0},
{ 3, s_9_7, 0, 1, 0},
{ 3, s_9_8, 0, 1, 0},
{ 2, s_9_9, 0, 1, 0},
{ 3, s_9_10, 0, 1, 0},
{ 3, s_9_11, 0, 2, 0},
{ 2, s_9_12, 0, 1, 0},
{ 3, s_9_13, 0, 1, 0},
{ 3, s_9_14, 0, 1, 0},
{ 3, s_9_15, 0, 1, 0},
{ 4, s_9_16, -1, 1, 0},
{ 5, s_9_17, -1, 1, 0}
};

static const symbol s_10_0[1] = { 'e' };
static const symbol s_10_1[1] = { 'l' };
static const struct among a_10[2] = {
{ 1, s_10_0, 0, 1, 0},
{ 1, s_10_1, 0, 2, 0}
};

static const symbol s_11_0[5] = { 'a', 'n', 'd', 'e', 's' };
static const symbol s_11_1[5] = { 'a', 't', 'l', 'a', 's' };
static const symbol s_11_2[4] = { 'b', 'i', 'a', 's' };
static const symbol s_11_3[6] = { 'c', 'o', 's', 'm', 'o', 's' };
static const symbol s_11_4[5] = { 'e', 'a', 'r', 'l', 'y' };
static const symbol s_11_5[6] = { 'g', 'e', 'n', 't', 'l', 'y' };
static const symbol s_11_6[4] = { 'h', 'o', 'w', 'e' };
static const symbol s_11_7[4] = { 'i', 'd', 'l', 'y' };
static const symbol s_11_8[4] = { 'n', 'e', 'w', 's' };
static const symbol s_11_9[4] = { 'o', 'n', 'l', 'y' };
static const symbol s_11_10[6] = { 's', 'i', 'n', 'g', 'l', 'y' };
static const symbol s_11_11[5] = { 's', 'k', 'i', 'e', 's' };
static const symbol s_11_12[4] = { 's', 'k', 'i', 's' };
static const symbol s_11_13[3] = { 's', 'k', 'y' };
static const symbol s_11_14[4] = { 'u', 'g', 'l', 'y' };
static const struct among a_11[15] = {
{ 5, s_11_0, 0, -1, 0},
{ 5, s_11_1, 0, -1, 0},
{ 4, s_11_2, 0, -1, 0},
{ 6, s_11_3, 0, -1, 0},
{ 5, s_11_4, 0, 6, 0},
{ 6, s_11_5, 0, 4, 0},
{ 4, s_11_6, 0, -1, 0},
{ 4, s_11_7, 0, 3, 0},
{ 4, s_11_8, 0, -1, 0},
{ 4, s_11_9, 0, 7, 0},
{ 6, s_11_10, 0, 8, 0},
{ 5, s_11_11, 0, 2, 0},
{ 4, s_11_12, 0, 1, 0},
{ 3, s_11_13, 0, -1, 0},
{ 4, s_11_14, 0, 5, 0}
};

static const unsigned char g_aeo[] = { 17, 64 };

static const unsigned char g_v[] = { 17, 65, 16, 1 };

static const unsigned char g_v_WXY[] = { 1, 17, 65, 208, 1 };

static const unsigned char g_valid_LI[] = { 55, 141, 2 };

static int r_shortv(struct SN_env * z) {
    do {
        int v_1 = z->l - z->c;
        if (out_grouping_b(z, g_v_WXY, 89, 121, 0)) goto lab0;
        if (in_grouping_b(z, g_v, 97, 121, 0)) goto lab0;
        if (out_grouping_b(z, g_v, 97, 121, 0)) goto lab0;
        break;
    lab0:
        z->c = z->l - v_1;
        if (out_grouping_b(z, g_v, 97, 121, 0)) goto lab1;
        if (in_grouping_b(z, g_v, 97, 121, 0)) goto lab1;
        if (z->c > z->lb) goto lab1;
        break;
    lab1:
        z->c = z->l - v_1;
        if (!(eq_s_b(z, 4, s_0))) return 0;
    } while (0);
    return 1;
}

extern int english_stem(struct SN_env * z) {
    int among_var;
    int b_Y_found;
    int i_p2;
    int i_p1;
    do {
        int v_1 = z->c;
        z->bra = z->c;
        if (z->c + 2 >= z->l || z->p[z->c + 2] >> 5 != 3 || !((42750482 >> (z->p[z->c + 2] & 0x1f)) & 1)) goto lab0;
        among_var = find_among(z, a_11, 15, 0);
        if (!among_var) goto lab0;
        z->ket = z->c;
        if (z->c < z->l) goto lab0;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 3, s_1);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 3, s_2);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 3, s_3);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 5, s_4);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                {
                    int ret = slice_from_s(z, 4, s_5);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                {
                    int ret = slice_from_s(z, 5, s_6);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                {
                    int ret = slice_from_s(z, 4, s_7);
                    if (ret < 0) return ret;
                }
                break;
            case 8:
                {
                    int ret = slice_from_s(z, 5, s_8);
                    if (ret < 0) return ret;
                }
                break;
        }
        break;
    lab0:
        z->c = v_1;
        if (z->c + 3 > z->l) goto lab2;
        z->c += 3;
        goto lab1;
    lab2:
        break;
    lab1:
        z->c = v_1;
        b_Y_found = 0;
        {
            int v_2 = z->c;
            z->bra = z->c;
            if (z->c == z->l || z->p[z->c] != '\'') goto lab4;
            z->c++;
            z->ket = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab4:
            z->c = v_2;
        }
        {
            int v_3 = z->c;
            z->bra = z->c;
            if (z->c == z->l || z->p[z->c] != 'y') goto lab5;
            z->c++;
            z->ket = z->c;
            {
                int ret = slice_from_s(z, 1, s_9);
                if (ret < 0) return ret;
            }
            b_Y_found = 1;
        lab5:
            z->c = v_3;
        }
        {
            int v_4 = z->c;
            while (1) {
                int v_5 = z->c;
                while (1) {
                    int v_6 = z->c;
                    if (in_grouping(z, g_v, 97, 121, 0)) goto lab8;
                    z->bra = z->c;
                    if (z->c == z->l || z->p[z->c] != 'y') goto lab8;
                    z->c++;
                    z->ket = z->c;
                    z->c = v_6;
                    break;
                lab8:
                    z->c = v_6;
                    if (z->c >= z->l) goto lab7;
                    z->c++;
                }
                {
                    int ret = slice_from_s(z, 1, s_10);
                    if (ret < 0) return ret;
                }
                b_Y_found = 1;
                continue;
            lab7:
                z->c = v_5;
                break;
            }
            z->c = v_4;
        }
        i_p1 = z->l;
        i_p2 = z->l;
        {
            int v_7 = z->c;
            do {
                int v_8 = z->c;
                if (z->c + 3 >= z->l || z->p[z->c + 3] >> 5 != 3 || !((5513250 >> (z->p[z->c + 3] & 0x1f)) & 1)) goto lab11;
                if (!find_among(z, a_0, 9, 0)) goto lab11;
                break;
            lab11:
                z->c = v_8;
                {
                    int ret = out_grouping(z, g_v, 97, 121, 1);
                    if (ret < 0) goto lab10;
                    z->c += ret;
                }
                {
                    int ret = in_grouping(z, g_v, 97, 121, 1);
                    if (ret < 0) goto lab10;
                    z->c += ret;
                }
            } while (0);
            i_p1 = z->c;
            {
                int ret = out_grouping(z, g_v, 97, 121, 1);
                if (ret < 0) goto lab10;
                z->c += ret;
            }
            {
                int ret = in_grouping(z, g_v, 97, 121, 1);
                if (ret < 0) goto lab10;
                z->c += ret;
            }
            i_p2 = z->c;
        lab10:
            z->c = v_7;
        }
        z->lb = z->c; z->c = z->l;
        {
            int v_9 = z->l - z->c;
            {
                int v_10 = z->l - z->c;
                z->ket = z->c;
                if (z->c <= z->lb || (z->p[z->c - 1] != 39 && z->p[z->c - 1] != 115)) { z->c = z->l - v_10; goto lab13; }
                if (!find_among_b(z, a_1, 3, 0)) { z->c = z->l - v_10; goto lab13; }
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
            lab13:
                ;
            }
            z->ket = z->c;
            if (z->c <= z->lb || (z->p[z->c - 1] != 100 && z->p[z->c - 1] != 115)) goto lab12;
            among_var = find_among_b(z, a_2, 6, 0);
            if (!among_var) goto lab12;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 2, s_11);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    do {
                        int v_11 = z->l - z->c;
                        if (z->c - 2 < z->lb) goto lab14;
                        z->c -= 2;
                        {
                            int ret = slice_from_s(z, 1, s_12);
                            if (ret < 0) return ret;
                        }
                        break;
                    lab14:
                        z->c = z->l - v_11;
                        {
                            int ret = slice_from_s(z, 2, s_13);
                            if (ret < 0) return ret;
                        }
                    } while (0);
                    break;
                case 3:
                    if (z->c <= z->lb) goto lab12;
                    z->c--;
                    {
                        int ret = out_grouping_b(z, g_v, 97, 121, 1);
                        if (ret < 0) goto lab12;
                        z->c -= ret;
                    }
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab12:
            z->c = z->l - v_9;
        }
        {
            int v_12 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((33554576 >> (z->p[z->c - 1] & 0x1f)) & 1)) among_var = -1; else
            among_var = find_among_b(z, a_5, 7, 0);
            z->bra = z->c;
            do {
                int v_13 = z->l - z->c;
                switch (among_var) {
                    case 1:
                        {
                            int v_14 = z->l - z->c;
                            if (i_p1 > z->c) goto lab17;
                            do {
                                int v_15 = z->l - z->c;
                                if (z->c - 2 <= z->lb || z->p[z->c - 1] != 99) goto lab18;
                                if (!find_among_b(z, a_3, 3, 0)) goto lab18;
                                if (z->c > z->lb) goto lab18;
                                break;
                            lab18:
                                z->c = z->l - v_15;
                                {
                                    int ret = slice_from_s(z, 2, s_14);
                                    if (ret < 0) return ret;
                                }
                            } while (0);
                        lab17:
                            z->c = z->l - v_14;
                        }
                        break;
                    case 2:
                        goto lab16;
                        break;
                    case 3:
                        if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((34881536 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab16;
                        among_var = find_among_b(z, a_4, 7, 0);
                        if (!among_var) goto lab16;
                        switch (among_var) {
                            case 1:
                                {
                                    int v_16 = z->l - z->c;
                                    if (out_grouping_b(z, g_v, 97, 121, 0)) goto lab16;
                                    if (z->c > z->lb) goto lab16;
                                    z->c = z->l - v_16;
                                }
                                z->bra = z->c;
                                {
                                    int ret = slice_from_s(z, 2, s_15);
                                    if (ret < 0) return ret;
                                }
                                break;
                            case 2:
                                if (z->c > z->lb) goto lab16;
                                break;
                        }
                        break;
                }
                break;
            lab16:
                z->c = z->l - v_13;
                {
                    int v_17 = z->l - z->c;
                    {
                        int ret = out_grouping_b(z, g_v, 97, 121, 1);
                        if (ret < 0) goto lab15;
                        z->c -= ret;
                    }
                    z->c = z->l - v_17;
                }
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                z->ket = z->c;
                z->bra = z->c;
                {
                    int v_18 = z->l - z->c;
                    if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((68514004 >> (z->p[z->c - 1] & 0x1f)) & 1)) among_var = 3; else
                    among_var = find_among_b(z, a_6, 13, 0);
                    switch (among_var) {
                        case 1:
                            {
                                int ret = slice_from_s(z, 1, s_16);
                                if (ret < 0) return ret;
                            }
                            goto lab15;
                            break;
                        case 2:
                            {
                                int v_19 = z->l - z->c;
                                if (in_grouping_b(z, g_aeo, 97, 111, 0)) goto lab19;
                                if (z->c > z->lb) goto lab19;
                                goto lab15;
                            lab19:
                                z->c = z->l - v_19;
                            }
                            break;
                        case 3:
                            if (z->c != i_p1) goto lab15;
                            {
                                int v_20 = z->l - z->c;
                                if (!r_shortv(z)) goto lab15;
                                z->c = z->l - v_20;
                            }
                            {
                                int ret = slice_from_s(z, 1, s_17);
                                if (ret < 0) return ret;
                            }
                            goto lab15;
                            break;
                    }
                    z->c = z->l - v_18;
                }
                z->ket = z->c;
                if (z->c <= z->lb) goto lab15;
                z->c--;
                z->bra = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
            } while (0);
        lab15:
            z->c = z->l - v_12;
        }
        {
            int v_21 = z->l - z->c;
            z->ket = z->c;
            do {
                if (z->c <= z->lb || z->p[z->c - 1] != 'y') goto lab21;
                z->c--;
                break;
            lab21:
                if (z->c <= z->lb || z->p[z->c - 1] != 'Y') goto lab20;
                z->c--;
            } while (0);
            z->bra = z->c;
            if (out_grouping_b(z, g_v, 97, 121, 0)) goto lab20;
            if (z->c <= z->lb) goto lab20;
            {
                int ret = slice_from_s(z, 1, s_18);
                if (ret < 0) return ret;
            }
        lab20:
            z->c = z->l - v_21;
        }
        {
            int v_22 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1864192 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab22;
            among_var = find_among_b(z, a_7, 25, 0);
            if (!among_var) goto lab22;
            z->bra = z->c;
            if (i_p1 > z->c) goto lab22;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 4, s_19);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 4, s_20);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    {
                        int ret = slice_from_s(z, 4, s_21);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    {
                        int ret = slice_from_s(z, 4, s_22);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    {
                        int ret = slice_from_s(z, 3, s_23);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    {
                        int ret = slice_from_s(z, 3, s_24);
                        if (ret < 0) return ret;
                    }
                    break;
                case 7:
                    {
                        int ret = slice_from_s(z, 3, s_25);
                        if (ret < 0) return ret;
                    }
                    break;
                case 8:
                    {
                        int ret = slice_from_s(z, 2, s_26);
                        if (ret < 0) return ret;
                    }
                    break;
                case 9:
                    {
                        int ret = slice_from_s(z, 3, s_27);
                        if (ret < 0) return ret;
                    }
                    break;
                case 10:
                    {
                        int ret = slice_from_s(z, 3, s_28);
                        if (ret < 0) return ret;
                    }
                    break;
                case 11:
                    {
                        int ret = slice_from_s(z, 3, s_29);
                        if (ret < 0) return ret;
                    }
                    break;
                case 12:
                    {
                        int ret = slice_from_s(z, 3, s_30);
                        if (ret < 0) return ret;
                    }
                    break;
                case 13:
                    {
                        int ret = slice_from_s(z, 2, s_31);
                        if (ret < 0) return ret;
                    }
                    break;
                case 14:
                    if (z->c <= z->lb || z->p[z->c - 1] != 'l') goto lab22;
                    z->c--;
                    {
                        int ret = slice_from_s(z, 2, s_32);
                        if (ret < 0) return ret;
                    }
                    break;
                case 15:
                    {
                        int ret = slice_from_s(z, 4, s_33);
                        if (ret < 0) return ret;
                    }
                    break;
                case 16:
                    if (in_grouping_b(z, g_valid_LI, 99, 116, 0)) goto lab22;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab22:
            z->c = z->l - v_22;
        }
        {
            int v_23 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 2 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((528928 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab23;
            among_var = find_among_b(z, a_8, 9, 0);
            if (!among_var) goto lab23;
            z->bra = z->c;
            if (i_p1 > z->c) goto lab23;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_from_s(z, 4, s_34);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    {
                        int ret = slice_from_s(z, 3, s_35);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    {
                        int ret = slice_from_s(z, 2, s_36);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    {
                        int ret = slice_from_s(z, 2, s_37);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    if (i_p2 > z->c) goto lab23;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab23:
            z->c = z->l - v_23;
        }
        {
            int v_24 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1864232 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab24;
            among_var = find_among_b(z, a_9, 18, 0);
            if (!among_var) goto lab24;
            z->bra = z->c;
            if (i_p2 > z->c) goto lab24;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    do {
                        if (z->c <= z->lb || z->p[z->c - 1] != 's') goto lab25;
                        z->c--;
                        break;
                    lab25:
                        if (z->c <= z->lb || z->p[z->c - 1] != 't') goto lab24;
                        z->c--;
                    } while (0);
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab24:
            z->c = z->l - v_24;
        }
        {
            int v_25 = z->l - z->c;
            z->ket = z->c;
            if (z->c <= z->lb || (z->p[z->c - 1] != 101 && z->p[z->c - 1] != 108)) goto lab26;
            among_var = find_among_b(z, a_10, 2, 0);
            if (!among_var) goto lab26;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    do {
                        if (i_p2 > z->c) goto lab27;
                        break;
                    lab27:
                        if (i_p1 > z->c) goto lab26;
                        {
                            int v_26 = z->l - z->c;
                            if (!r_shortv(z)) goto lab28;
                            goto lab26;
                        lab28:
                            z->c = z->l - v_26;
                        }
                    } while (0);
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (i_p2 > z->c) goto lab26;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'l') goto lab26;
                    z->c--;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab26:
            z->c = z->l - v_25;
        }
        z->c = z->lb;
        {
            int v_27 = z->c;
            if (!b_Y_found) goto lab29;
            while (1) {
                int v_28 = z->c;
                while (1) {
                    int v_29 = z->c;
                    z->bra = z->c;
                    if (z->c == z->l || z->p[z->c] != 'Y') goto lab31;
                    z->c++;
                    z->ket = z->c;
                    z->c = v_29;
                    break;
                lab31:
                    z->c = v_29;
                    if (z->c >= z->l) goto lab30;
                    z->c++;
                }
                {
                    int ret = slice_from_s(z, 1, s_38);
                    if (ret < 0) return ret;
                }
                continue;
            lab30:
                z->c = v_28;
                break;
            }
        lab29:
            z->c = v_27;
        }
    } while (0);
    return 1;
}

extern struct SN_env * english_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
