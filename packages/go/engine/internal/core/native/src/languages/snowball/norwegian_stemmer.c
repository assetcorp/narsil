/*
 * Generated from algorithms/norwegian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "norwegian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int norwegian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 'e', 'r' };

static const symbol s_0_1[3] = { 'i', 'n', 'd' };
static const symbol s_0_2[2] = { 'k', 'k' };
static const symbol s_0_3[2] = { 'n', 'k' };
static const symbol s_0_4[3] = { 'a', 'm', 'm' };
static const symbol s_0_5[3] = { 'o', 'm', 'm' };
static const symbol s_0_6[3] = { 'k', 'a', 'p' };
static const symbol s_0_7[4] = { 's', 'k', 'a', 'p' };
static const symbol s_0_8[2] = { 'p', 'p' };
static const symbol s_0_9[2] = { 'l', 't' };
static const symbol s_0_10[3] = { 'a', 's', 't' };
static const symbol s_0_11[3] = { 0xF8, 's', 't' };
static const symbol s_0_12[1] = { 'v' };
static const symbol s_0_13[3] = { 'h', 'a', 'v' };
static const symbol s_0_14[3] = { 'g', 'i', 'v' };
static const struct among a_0[15] = {
{ 0, 0, 0, 1, 0},
{ 3, s_0_1, -1, -1, 0},
{ 2, s_0_2, -2, -1, 0},
{ 2, s_0_3, -3, -1, 0},
{ 3, s_0_4, -4, -1, 0},
{ 3, s_0_5, -5, -1, 0},
{ 3, s_0_6, -6, -1, 0},
{ 4, s_0_7, -1, 1, 0},
{ 2, s_0_8, -8, -1, 0},
{ 2, s_0_9, -9, -1, 0},
{ 3, s_0_10, -10, -1, 0},
{ 3, s_0_11, -11, -1, 0},
{ 1, s_0_12, -12, -1, 0},
{ 3, s_0_13, -1, 1, 0},
{ 3, s_0_14, -2, 1, 0}
};

static const symbol s_1_0[1] = { 'a' };
static const symbol s_1_1[1] = { 'e' };
static const symbol s_1_2[3] = { 'e', 'd', 'e' };
static const symbol s_1_3[4] = { 'a', 'n', 'd', 'e' };
static const symbol s_1_4[4] = { 'e', 'n', 'd', 'e' };
static const symbol s_1_5[3] = { 'a', 'n', 'e' };
static const symbol s_1_6[3] = { 'e', 'n', 'e' };
static const symbol s_1_7[6] = { 'h', 'e', 't', 'e', 'n', 'e' };
static const symbol s_1_8[4] = { 'e', 'r', 't', 'e' };
static const symbol s_1_9[2] = { 'e', 'n' };
static const symbol s_1_10[5] = { 'h', 'e', 't', 'e', 'n' };
static const symbol s_1_11[2] = { 'a', 'r' };
static const symbol s_1_12[2] = { 'e', 'r' };
static const symbol s_1_13[5] = { 'h', 'e', 't', 'e', 'r' };
static const symbol s_1_14[1] = { 's' };
static const symbol s_1_15[2] = { 'a', 's' };
static const symbol s_1_16[2] = { 'e', 's' };
static const symbol s_1_17[4] = { 'e', 'd', 'e', 's' };
static const symbol s_1_18[5] = { 'e', 'n', 'd', 'e', 's' };
static const symbol s_1_19[4] = { 'e', 'n', 'e', 's' };
static const symbol s_1_20[7] = { 'h', 'e', 't', 'e', 'n', 'e', 's' };
static const symbol s_1_21[3] = { 'e', 'n', 's' };
static const symbol s_1_22[6] = { 'h', 'e', 't', 'e', 'n', 's' };
static const symbol s_1_23[3] = { 'e', 'r', 's' };
static const symbol s_1_24[3] = { 'e', 't', 's' };
static const symbol s_1_25[2] = { 'e', 't' };
static const symbol s_1_26[3] = { 'h', 'e', 't' };
static const symbol s_1_27[3] = { 'e', 'r', 't' };
static const symbol s_1_28[3] = { 'a', 's', 't' };
static const struct among a_1[29] = {
{ 1, s_1_0, 0, 1, 0},
{ 1, s_1_1, 0, 1, 0},
{ 3, s_1_2, -1, 1, 0},
{ 4, s_1_3, -2, 1, 0},
{ 4, s_1_4, -3, 1, 0},
{ 3, s_1_5, -4, 1, 0},
{ 3, s_1_6, -5, 1, 0},
{ 6, s_1_7, -1, 1, 0},
{ 4, s_1_8, -7, 4, 0},
{ 2, s_1_9, 0, 1, 0},
{ 5, s_1_10, -1, 1, 0},
{ 2, s_1_11, 0, 1, 0},
{ 2, s_1_12, 0, 1, 0},
{ 5, s_1_13, -1, 1, 0},
{ 1, s_1_14, 0, 3, 0},
{ 2, s_1_15, -1, 1, 0},
{ 2, s_1_16, -2, 1, 0},
{ 4, s_1_17, -1, 1, 0},
{ 5, s_1_18, -2, 1, 0},
{ 4, s_1_19, -3, 1, 0},
{ 7, s_1_20, -1, 1, 0},
{ 3, s_1_21, -7, 1, 0},
{ 6, s_1_22, -1, 1, 0},
{ 3, s_1_23, -9, 2, 0},
{ 3, s_1_24, -10, 1, 0},
{ 2, s_1_25, 0, 1, 0},
{ 3, s_1_26, -1, 1, 0},
{ 3, s_1_27, 0, 4, 0},
{ 3, s_1_28, 0, 1, 0}
};

static const symbol s_2_0[2] = { 'd', 't' };
static const symbol s_2_1[2] = { 'v', 't' };
static const struct among a_2[2] = {
{ 2, s_2_0, 0, -1, 0},
{ 2, s_2_1, 0, -1, 0}
};

static const symbol s_3_0[3] = { 'l', 'e', 'g' };
static const symbol s_3_1[4] = { 'e', 'l', 'e', 'g' };
static const symbol s_3_2[2] = { 'i', 'g' };
static const symbol s_3_3[3] = { 'e', 'i', 'g' };
static const symbol s_3_4[3] = { 'l', 'i', 'g' };
static const symbol s_3_5[4] = { 'e', 'l', 'i', 'g' };
static const symbol s_3_6[3] = { 'e', 'l', 's' };
static const symbol s_3_7[3] = { 'l', 'o', 'v' };
static const symbol s_3_8[4] = { 'e', 'l', 'o', 'v' };
static const symbol s_3_9[4] = { 's', 'l', 'o', 'v' };
static const symbol s_3_10[7] = { 'h', 'e', 't', 's', 'l', 'o', 'v' };
static const struct among a_3[11] = {
{ 3, s_3_0, 0, 1, 0},
{ 4, s_3_1, -1, 1, 0},
{ 2, s_3_2, 0, 1, 0},
{ 3, s_3_3, -1, 1, 0},
{ 3, s_3_4, -2, 1, 0},
{ 4, s_3_5, -1, 1, 0},
{ 3, s_3_6, 0, 1, 0},
{ 3, s_3_7, 0, 1, 0},
{ 4, s_3_8, -1, 1, 0},
{ 4, s_3_9, -2, 1, 0},
{ 7, s_3_10, -1, 1, 0}
};

static const unsigned char g_v[] = { 17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 48, 2, 142 };

static const unsigned char g_s_ending[] = { 119, 125, 148, 1 };

extern int norwegian_stem(struct SN_env * z) {
    int among_var;
    int i_p1;
    i_p1 = z->l;
    {
        int v_1 = z->c;
        do {
            int v_2 = z->c;
            while (1) {
                if (z->c == z->l || z->p[z->c] != '\'') goto lab2;
                z->c++;
                break;
            lab2:
                if (z->c >= z->l) goto lab1;
                z->c++;
            }
            break;
        lab1:
            z->c = v_2;
            {
                int ret = out_grouping(z, g_v, 97, 248, 1);
                if (ret < 0) goto lab0;
                z->c += ret;
            }
            {
                int ret = in_grouping(z, g_v, 97, 248, 1);
                if (ret < 0) goto lab0;
                z->c += ret;
            }
        } while (0);
        i_p1 = z->c;
    lab0:
        z->c = v_1;
    }
    {
        int v_3 = z->c;
        if (z->c + 3 > z->l) return 0;
        z->c += 3;
        if (i_p1 >= z->c) goto lab3;
        i_p1 = z->c;
    lab3:
        z->c = v_3;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_4 = z->l - z->c;
        {
            int v_5;
            if (z->c < i_p1) goto lab4;
            v_5 = z->lb; z->lb = i_p1;
            z->ket = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1851426 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->lb = v_5; goto lab4; }
            among_var = find_among_b(z, a_1, 29, 0);
            if (!among_var) { z->lb = v_5; goto lab4; }
            z->bra = z->c;
            z->lb = v_5;
        }
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((5318672 >> (z->p[z->c - 1] & 0x1f)) & 1)) among_var = 1; else
                among_var = find_among_b(z, a_0, 15, 0);
                switch (among_var) {
                    case 1:
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        break;
                }
                break;
            case 3:
                do {
                    int v_6 = z->l - z->c;
                    if (in_grouping_b(z, g_s_ending, 98, 122, 0)) goto lab5;
                    break;
                lab5:
                    if (z->c <= z->lb || z->p[z->c - 1] != 'r') goto lab6;
                    z->c--;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'e') goto lab7;
                    z->c--;
                    goto lab6;
                lab7:
                    break;
                lab6:
                    z->c = z->l - v_6;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'k') goto lab4;
                    z->c--;
                    if (out_grouping_b(z, g_v, 97, 248, 0)) goto lab4;
                } while (0);
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 2, s_0);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab4:
        z->c = z->l - v_4;
    }
    {
        int v_7 = z->l - z->c;
        {
            int v_8 = z->l - z->c;
            {
                int v_9;
                if (z->c < i_p1) goto lab8;
                v_9 = z->lb; z->lb = i_p1;
                z->ket = z->c;
                if (z->c - 1 <= z->lb || z->p[z->c - 1] != 116) { z->lb = v_9; goto lab8; }
                if (!find_among_b(z, a_2, 2, 0)) { z->lb = v_9; goto lab8; }
                z->bra = z->c;
                z->lb = v_9;
            }
            z->c = z->l - v_8;
        }
        if (z->c <= z->lb) goto lab8;
        z->c--;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab8:
        z->c = z->l - v_7;
    }
    {
        int v_10 = z->l - z->c;
        {
            int v_11;
            if (z->c < i_p1) goto lab9;
            v_11 = z->lb; z->lb = i_p1;
            z->ket = z->c;
            if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((4718720 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->lb = v_11; goto lab9; }
            if (!find_among_b(z, a_3, 11, 0)) { z->lb = v_11; goto lab9; }
            z->bra = z->c;
            z->lb = v_11;
        }
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab9:
        z->c = z->l - v_10;
    }
    z->ket = z->c;
    if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
    z->c--;
    z->bra = z->c;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * norwegian_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
