/*
 * Generated from algorithms/irish.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "irish_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int irish_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 'f' };
static const symbol s_1[] = { 's' };
static const symbol s_2[] = { 'b' };
static const symbol s_3[] = { 'c' };
static const symbol s_4[] = { 'd' };
static const symbol s_5[] = { 'g' };
static const symbol s_6[] = { 'p' };
static const symbol s_7[] = { 't' };
static const symbol s_8[] = { 'm' };
static const symbol s_9[] = { 'a', 'r', 'c' };
static const symbol s_10[] = { 'g', 'i', 'n' };
static const symbol s_11[] = { 'g', 'r', 'a', 'f' };
static const symbol s_12[] = { 'p', 'a', 'i', 't', 'e' };
static const symbol s_13[] = { 0xF3, 'i', 'd' };

static const symbol s_0_0[2] = { 'b', '\'' };
static const symbol s_0_1[2] = { 'b', 'h' };
static const symbol s_0_2[3] = { 'b', 'h', 'f' };
static const symbol s_0_3[2] = { 'b', 'p' };
static const symbol s_0_4[2] = { 'c', 'h' };
static const symbol s_0_5[2] = { 'd', '\'' };
static const symbol s_0_6[4] = { 'd', '\'', 'f', 'h' };
static const symbol s_0_7[2] = { 'd', 'h' };
static const symbol s_0_8[2] = { 'd', 't' };
static const symbol s_0_9[2] = { 'f', 'h' };
static const symbol s_0_10[2] = { 'g', 'c' };
static const symbol s_0_11[2] = { 'g', 'h' };
static const symbol s_0_12[2] = { 'h', '-' };
static const symbol s_0_13[2] = { 'm', '\'' };
static const symbol s_0_14[2] = { 'm', 'b' };
static const symbol s_0_15[2] = { 'm', 'h' };
static const symbol s_0_16[2] = { 'n', '-' };
static const symbol s_0_17[2] = { 'n', 'd' };
static const symbol s_0_18[2] = { 'n', 'g' };
static const symbol s_0_19[2] = { 'p', 'h' };
static const symbol s_0_20[2] = { 's', 'h' };
static const symbol s_0_21[2] = { 't', '-' };
static const symbol s_0_22[2] = { 't', 'h' };
static const symbol s_0_23[2] = { 't', 's' };
static const struct among a_0[24] = {
{ 2, s_0_0, 0, 1, 0},
{ 2, s_0_1, 0, 4, 0},
{ 3, s_0_2, -1, 2, 0},
{ 2, s_0_3, 0, 8, 0},
{ 2, s_0_4, 0, 5, 0},
{ 2, s_0_5, 0, 1, 0},
{ 4, s_0_6, -1, 2, 0},
{ 2, s_0_7, 0, 6, 0},
{ 2, s_0_8, 0, 9, 0},
{ 2, s_0_9, 0, 2, 0},
{ 2, s_0_10, 0, 5, 0},
{ 2, s_0_11, 0, 7, 0},
{ 2, s_0_12, 0, 1, 0},
{ 2, s_0_13, 0, 1, 0},
{ 2, s_0_14, 0, 4, 0},
{ 2, s_0_15, 0, 10, 0},
{ 2, s_0_16, 0, 1, 0},
{ 2, s_0_17, 0, 6, 0},
{ 2, s_0_18, 0, 7, 0},
{ 2, s_0_19, 0, 8, 0},
{ 2, s_0_20, 0, 3, 0},
{ 2, s_0_21, 0, 1, 0},
{ 2, s_0_22, 0, 9, 0},
{ 2, s_0_23, 0, 3, 0}
};

static const symbol s_1_0[6] = { 0xED, 'o', 'c', 'h', 't', 'a' };
static const symbol s_1_1[7] = { 'a', 0xED, 'o', 'c', 'h', 't', 'a' };
static const symbol s_1_2[3] = { 'i', 'r', 'e' };
static const symbol s_1_3[4] = { 'a', 'i', 'r', 'e' };
static const symbol s_1_4[3] = { 'a', 'b', 'h' };
static const symbol s_1_5[4] = { 'e', 'a', 'b', 'h' };
static const symbol s_1_6[3] = { 'i', 'b', 'h' };
static const symbol s_1_7[4] = { 'a', 'i', 'b', 'h' };
static const symbol s_1_8[3] = { 'a', 'm', 'h' };
static const symbol s_1_9[4] = { 'e', 'a', 'm', 'h' };
static const symbol s_1_10[3] = { 'i', 'm', 'h' };
static const symbol s_1_11[4] = { 'a', 'i', 'm', 'h' };
static const symbol s_1_12[5] = { 0xED, 'o', 'c', 'h', 't' };
static const symbol s_1_13[6] = { 'a', 0xED, 'o', 'c', 'h', 't' };
static const symbol s_1_14[3] = { 'i', 'r', 0xED };
static const symbol s_1_15[4] = { 'a', 'i', 'r', 0xED };
static const struct among a_1[16] = {
{ 6, s_1_0, 0, 1, 0},
{ 7, s_1_1, -1, 1, 0},
{ 3, s_1_2, 0, 2, 0},
{ 4, s_1_3, -1, 2, 0},
{ 3, s_1_4, 0, 1, 0},
{ 4, s_1_5, -1, 1, 0},
{ 3, s_1_6, 0, 1, 0},
{ 4, s_1_7, -1, 1, 0},
{ 3, s_1_8, 0, 1, 0},
{ 4, s_1_9, -1, 1, 0},
{ 3, s_1_10, 0, 1, 0},
{ 4, s_1_11, -1, 1, 0},
{ 5, s_1_12, 0, 1, 0},
{ 6, s_1_13, -1, 1, 0},
{ 3, s_1_14, 0, 2, 0},
{ 4, s_1_15, -1, 2, 0}
};

static const symbol s_2_0[8] = { 0xF3, 'i', 'd', 'e', 'a', 'c', 'h', 'a' };
static const symbol s_2_1[7] = { 'p', 'a', 't', 'a', 'c', 'h', 'a' };
static const symbol s_2_2[5] = { 'a', 'c', 'h', 't', 'a' };
static const symbol s_2_3[8] = { 'a', 'r', 'c', 'a', 'c', 'h', 't', 'a' };
static const symbol s_2_4[6] = { 'e', 'a', 'c', 'h', 't', 'a' };
static const symbol s_2_5[11] = { 'g', 'r', 'a', 'f', 'a', 0xED, 'o', 'c', 'h', 't', 'a' };
static const symbol s_2_6[5] = { 'p', 'a', 'i', 't', 'e' };
static const symbol s_2_7[3] = { 'a', 'c', 'h' };
static const symbol s_2_8[4] = { 'e', 'a', 'c', 'h' };
static const symbol s_2_9[7] = { 0xF3, 'i', 'd', 'e', 'a', 'c', 'h' };
static const symbol s_2_10[7] = { 'g', 'i', 'n', 'e', 'a', 'c', 'h' };
static const symbol s_2_11[6] = { 'p', 'a', 't', 'a', 'c', 'h' };
static const symbol s_2_12[9] = { 'g', 'r', 'a', 'f', 'a', 0xED, 'o', 'c', 'h' };
static const symbol s_2_13[7] = { 'p', 'a', 't', 'a', 'i', 'g', 'h' };
static const symbol s_2_14[6] = { 0xF3, 'i', 'd', 'i', 'g', 'h' };
static const symbol s_2_15[7] = { 'a', 'c', 'h', 't', 0xFA, 'i', 'l' };
static const symbol s_2_16[8] = { 'e', 'a', 'c', 'h', 't', 0xFA, 'i', 'l' };
static const symbol s_2_17[6] = { 'g', 'i', 'n', 'e', 'a', 's' };
static const symbol s_2_18[5] = { 'g', 'i', 'n', 'i', 's' };
static const symbol s_2_19[4] = { 'a', 'c', 'h', 't' };
static const symbol s_2_20[7] = { 'a', 'r', 'c', 'a', 'c', 'h', 't' };
static const symbol s_2_21[5] = { 'e', 'a', 'c', 'h', 't' };
static const symbol s_2_22[10] = { 'g', 'r', 'a', 'f', 'a', 0xED, 'o', 'c', 'h', 't' };
static const symbol s_2_23[9] = { 'a', 'r', 'c', 'a', 'c', 'h', 't', 'a', 0xED };
static const symbol s_2_24[12] = { 'g', 'r', 'a', 'f', 'a', 0xED, 'o', 'c', 'h', 't', 'a', 0xED };
static const struct among a_2[25] = {
{ 8, s_2_0, 0, 6, 0},
{ 7, s_2_1, 0, 5, 0},
{ 5, s_2_2, 0, 1, 0},
{ 8, s_2_3, -1, 2, 0},
{ 6, s_2_4, -2, 1, 0},
{ 11, s_2_5, 0, 4, 0},
{ 5, s_2_6, 0, 5, 0},
{ 3, s_2_7, 0, 1, 0},
{ 4, s_2_8, -1, 1, 0},
{ 7, s_2_9, -1, 6, 0},
{ 7, s_2_10, -2, 3, 0},
{ 6, s_2_11, -4, 5, 0},
{ 9, s_2_12, 0, 4, 0},
{ 7, s_2_13, 0, 5, 0},
{ 6, s_2_14, 0, 6, 0},
{ 7, s_2_15, 0, 1, 0},
{ 8, s_2_16, -1, 1, 0},
{ 6, s_2_17, 0, 3, 0},
{ 5, s_2_18, 0, 3, 0},
{ 4, s_2_19, 0, 1, 0},
{ 7, s_2_20, -1, 2, 0},
{ 5, s_2_21, -2, 1, 0},
{ 10, s_2_22, 0, 4, 0},
{ 9, s_2_23, 0, 2, 0},
{ 12, s_2_24, 0, 4, 0}
};

static const symbol s_3_0[4] = { 'i', 'm', 'i', 'd' };
static const symbol s_3_1[5] = { 'a', 'i', 'm', 'i', 'd' };
static const symbol s_3_2[4] = { 0xED, 'm', 'i', 'd' };
static const symbol s_3_3[5] = { 'a', 0xED, 'm', 'i', 'd' };
static const symbol s_3_4[3] = { 'a', 'd', 'h' };
static const symbol s_3_5[4] = { 'e', 'a', 'd', 'h' };
static const symbol s_3_6[5] = { 'f', 'a', 'i', 'd', 'h' };
static const symbol s_3_7[4] = { 'f', 'i', 'd', 'h' };
static const symbol s_3_8[3] = { 0xE1, 'i', 'l' };
static const symbol s_3_9[3] = { 'a', 'i', 'n' };
static const symbol s_3_10[4] = { 't', 'e', 'a', 'r' };
static const symbol s_3_11[3] = { 't', 'a', 'r' };
static const struct among a_3[12] = {
{ 4, s_3_0, 0, 1, 0},
{ 5, s_3_1, -1, 1, 0},
{ 4, s_3_2, 0, 1, 0},
{ 5, s_3_3, -1, 1, 0},
{ 3, s_3_4, 0, 2, 0},
{ 4, s_3_5, -1, 2, 0},
{ 5, s_3_6, 0, 1, 0},
{ 4, s_3_7, 0, 1, 0},
{ 3, s_3_8, 0, 2, 0},
{ 3, s_3_9, 0, 2, 0},
{ 4, s_3_10, 0, 2, 0},
{ 3, s_3_11, 0, 2, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 17, 4, 2 };

extern int irish_stem(struct SN_env * z) {
    int among_var;
    int i_p2;
    int i_p1;
    int i_pV;
    {
        int v_1 = z->c;
        z->bra = z->c;
        among_var = find_among(z, a_0, 24, 0);
        if (!among_var) goto lab0;
        z->ket = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_0);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_1);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 1, s_2);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                {
                    int ret = slice_from_s(z, 1, s_3);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                {
                    int ret = slice_from_s(z, 1, s_4);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                {
                    int ret = slice_from_s(z, 1, s_5);
                    if (ret < 0) return ret;
                }
                break;
            case 8:
                {
                    int ret = slice_from_s(z, 1, s_6);
                    if (ret < 0) return ret;
                }
                break;
            case 9:
                {
                    int ret = slice_from_s(z, 1, s_7);
                    if (ret < 0) return ret;
                }
                break;
            case 10:
                {
                    int ret = slice_from_s(z, 1, s_8);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab0:
        z->c = v_1;
    }
    i_pV = z->l;
    i_p1 = z->l;
    i_p2 = z->l;
    {
        int v_2 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab2;
            z->c += ret;
        }
        i_pV = z->c;
        {
            int ret = in_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab2;
            z->c += ret;
        }
        i_p1 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab2;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 250, 1);
            if (ret < 0) goto lab2;
            z->c += ret;
        }
        i_p2 = z->c;
    lab2:
        z->c = v_2;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_3 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_1, 16, 0);
        if (!among_var) goto lab3;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                if (i_p1 > z->c) goto lab3;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                if (i_p2 > z->c) goto lab3;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab3:
        z->c = z->l - v_3;
    }
    {
        int v_4 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_2, 25, 0);
        if (!among_var) goto lab4;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                if (i_p2 > z->c) goto lab4;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 3, s_9);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 3, s_10);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 4, s_11);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                {
                    int ret = slice_from_s(z, 5, s_12);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                {
                    int ret = slice_from_s(z, 3, s_13);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab4:
        z->c = z->l - v_4;
    }
    {
        int v_5 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 2 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((282896 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab5;
        among_var = find_among_b(z, a_3, 12, 0);
        if (!among_var) goto lab5;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                if (i_pV > z->c) goto lab5;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                if (i_p1 > z->c) goto lab5;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab5:
        z->c = z->l - v_5;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * irish_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
