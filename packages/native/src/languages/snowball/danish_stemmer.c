/*
 * Generated from algorithms/danish.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "danish_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

struct SN_local {
    struct SN_env z;
    int i_p1;
    symbol * s_ch;
};

typedef struct SN_local SN_local;

#ifdef __cplusplus
extern "C" {
#endif
extern int danish_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_consonant_pair(struct SN_env * z);

static const symbol s_0[] = { 's', 't' };
static const symbol s_1[] = { 'i', 'g' };
static const symbol s_2[] = { 'l', 0xF8, 's' };

static const symbol s_0_0[3] = { 'h', 'e', 'd' };
static const symbol s_0_1[5] = { 'e', 't', 'h', 'e', 'd' };
static const symbol s_0_2[4] = { 'e', 'r', 'e', 'd' };
static const symbol s_0_3[1] = { 'e' };
static const symbol s_0_4[5] = { 'e', 'r', 'e', 'd', 'e' };
static const symbol s_0_5[4] = { 'e', 'n', 'd', 'e' };
static const symbol s_0_6[6] = { 'e', 'r', 'e', 'n', 'd', 'e' };
static const symbol s_0_7[3] = { 'e', 'n', 'e' };
static const symbol s_0_8[4] = { 'e', 'r', 'n', 'e' };
static const symbol s_0_9[3] = { 'e', 'r', 'e' };
static const symbol s_0_10[2] = { 'e', 'n' };
static const symbol s_0_11[5] = { 'h', 'e', 'd', 'e', 'n' };
static const symbol s_0_12[4] = { 'e', 'r', 'e', 'n' };
static const symbol s_0_13[2] = { 'e', 'r' };
static const symbol s_0_14[5] = { 'h', 'e', 'd', 'e', 'r' };
static const symbol s_0_15[4] = { 'e', 'r', 'e', 'r' };
static const symbol s_0_16[1] = { 's' };
static const symbol s_0_17[4] = { 'h', 'e', 'd', 's' };
static const symbol s_0_18[2] = { 'e', 's' };
static const symbol s_0_19[5] = { 'e', 'n', 'd', 'e', 's' };
static const symbol s_0_20[7] = { 'e', 'r', 'e', 'n', 'd', 'e', 's' };
static const symbol s_0_21[4] = { 'e', 'n', 'e', 's' };
static const symbol s_0_22[5] = { 'e', 'r', 'n', 'e', 's' };
static const symbol s_0_23[4] = { 'e', 'r', 'e', 's' };
static const symbol s_0_24[3] = { 'e', 'n', 's' };
static const symbol s_0_25[6] = { 'h', 'e', 'd', 'e', 'n', 's' };
static const symbol s_0_26[5] = { 'e', 'r', 'e', 'n', 's' };
static const symbol s_0_27[3] = { 'e', 'r', 's' };
static const symbol s_0_28[3] = { 'e', 't', 's' };
static const symbol s_0_29[5] = { 'e', 'r', 'e', 't', 's' };
static const symbol s_0_30[2] = { 'e', 't' };
static const symbol s_0_31[4] = { 'e', 'r', 'e', 't' };
static const struct among a_0[32] = {
{ 3, s_0_0, 0, 1, 0},
{ 5, s_0_1, -1, 1, 0},
{ 4, s_0_2, 0, 1, 0},
{ 1, s_0_3, 0, 1, 0},
{ 5, s_0_4, -1, 1, 0},
{ 4, s_0_5, -2, 1, 0},
{ 6, s_0_6, -1, 1, 0},
{ 3, s_0_7, -4, 1, 0},
{ 4, s_0_8, -5, 1, 0},
{ 3, s_0_9, -6, 1, 0},
{ 2, s_0_10, 0, 1, 0},
{ 5, s_0_11, -1, 1, 0},
{ 4, s_0_12, -2, 1, 0},
{ 2, s_0_13, 0, 1, 0},
{ 5, s_0_14, -1, 1, 0},
{ 4, s_0_15, -2, 1, 0},
{ 1, s_0_16, 0, 2, 0},
{ 4, s_0_17, -1, 1, 0},
{ 2, s_0_18, -2, 1, 0},
{ 5, s_0_19, -1, 1, 0},
{ 7, s_0_20, -1, 1, 0},
{ 4, s_0_21, -3, 1, 0},
{ 5, s_0_22, -4, 1, 0},
{ 4, s_0_23, -5, 1, 0},
{ 3, s_0_24, -8, 1, 0},
{ 6, s_0_25, -1, 1, 0},
{ 5, s_0_26, -2, 1, 0},
{ 3, s_0_27, -11, 1, 0},
{ 3, s_0_28, -12, 1, 0},
{ 5, s_0_29, -1, 1, 0},
{ 2, s_0_30, 0, 1, 0},
{ 4, s_0_31, -1, 1, 0}
};

static const symbol s_1_0[2] = { 'g', 'd' };
static const symbol s_1_1[2] = { 'd', 't' };
static const symbol s_1_2[2] = { 'g', 't' };
static const symbol s_1_3[2] = { 'k', 't' };
static const struct among a_1[4] = {
{ 2, s_1_0, 0, -1, 0},
{ 2, s_1_1, 0, -1, 0},
{ 2, s_1_2, 0, -1, 0},
{ 2, s_1_3, 0, -1, 0}
};

static const symbol s_2_0[2] = { 'i', 'g' };
static const symbol s_2_1[3] = { 'l', 'i', 'g' };
static const symbol s_2_2[4] = { 'e', 'l', 'i', 'g' };
static const symbol s_2_3[3] = { 'e', 'l', 's' };
static const symbol s_2_4[4] = { 'l', 0xF8, 's', 't' };
static const struct among a_2[5] = {
{ 2, s_2_0, 0, 1, 0},
{ 3, s_2_1, -1, 1, 0},
{ 4, s_2_2, -1, 1, 0},
{ 3, s_2_3, 0, 1, 0},
{ 4, s_2_4, 0, 2, 0}
};

static const unsigned char g_undouble_c[] = { 53, 94, 7 };

static const unsigned char g_v[] = { 17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 48, 0, 128 };

static const unsigned char g_s_ending[] = { 1, 0, 0, 0, 0, 0, 0, 188, 251, 171, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 64 };

static int r_consonant_pair(struct SN_env * z) {
    {
        int v_1 = z->l - z->c;
        {
            int v_2;
            if (z->c < ((SN_local *)z)->i_p1) return 0;
            v_2 = z->lb; z->lb = ((SN_local *)z)->i_p1;
            z->ket = z->c;
            if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 100 && z->p[z->c - 1] != 116)) { z->lb = v_2; return 0; }
            if (!find_among_b(z, a_1, 4, 0)) { z->lb = v_2; return 0; }
            z->bra = z->c;
            z->lb = v_2;
        }
        z->c = z->l - v_1;
    }
    if (z->c <= z->lb) return 0;
    z->c--;
    z->bra = z->c;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    return 1;
}

extern int danish_stem(struct SN_env * z) {
    int among_var;
    ((SN_local *)z)->i_p1 = z->l;
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
        ((SN_local *)z)->i_p1 = z->c;
    lab0:
        z->c = v_1;
    }
    {
        int v_3 = z->c;
        if (z->c + 3 > z->l) return 0;
        z->c += 3;
        if (((SN_local *)z)->i_p1 >= z->c) goto lab3;
        ((SN_local *)z)->i_p1 = z->c;
    lab3:
        z->c = v_3;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_4 = z->l - z->c;
        {
            int v_5;
            if (z->c < ((SN_local *)z)->i_p1) goto lab4;
            v_5 = z->lb; z->lb = ((SN_local *)z)->i_p1;
            z->ket = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1851440 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->lb = v_5; goto lab4; }
            among_var = find_among_b(z, a_0, 32, 0);
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
                if (in_grouping_b(z, g_s_ending, 39, 229, 0)) goto lab4;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab4:
        z->c = z->l - v_4;
    }
    {
        int v_6 = z->l - z->c;
        {
            int ret = r_consonant_pair(z);
            if (ret < 0) return ret;
        }
        z->c = z->l - v_6;
    }
    {
        int v_7 = z->l - z->c;
        {
            int v_8 = z->l - z->c;
            z->ket = z->c;
            if (!(eq_s_b(z, 2, s_0))) goto lab6;
            z->bra = z->c;
            if (!(eq_s_b(z, 2, s_1))) goto lab6;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab6:
            z->c = z->l - v_8;
        }
        {
            int v_9;
            if (z->c < ((SN_local *)z)->i_p1) goto lab5;
            v_9 = z->lb; z->lb = ((SN_local *)z)->i_p1;
            z->ket = z->c;
            if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1572992 >> (z->p[z->c - 1] & 0x1f)) & 1)) { z->lb = v_9; goto lab5; }
            among_var = find_among_b(z, a_2, 5, 0);
            if (!among_var) { z->lb = v_9; goto lab5; }
            z->bra = z->c;
            z->lb = v_9;
        }
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int v_10 = z->l - z->c;
                    {
                        int ret = r_consonant_pair(z);
                        if (ret < 0) return ret;
                    }
                    z->c = z->l - v_10;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 3, s_2);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab5:
        z->c = z->l - v_7;
    }
    {
        int v_11 = z->l - z->c;
        {
            int v_12;
            if (z->c < ((SN_local *)z)->i_p1) goto lab7;
            v_12 = z->lb; z->lb = ((SN_local *)z)->i_p1;
            z->ket = z->c;
            if (in_grouping_b(z, g_undouble_c, 98, 116, 0)) { z->lb = v_12; goto lab7; }
            z->bra = z->c;
            {
                int ret = slice_to(z, &((SN_local *)z)->s_ch);
                if (ret < 0) return ret;
            }
            z->lb = v_12;
        }
        if (!(eq_v_b(z, ((SN_local *)z)->s_ch))) goto lab7;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab7:
        z->c = z->l - v_11;
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

extern struct SN_env * danish_create_env(void) {
    struct SN_env * z = SN_new_env(sizeof(SN_local));
    if (z) {
        if ((((SN_local *)z)->s_ch = create_s()) == NULL) {
            danish_close_env(z);
            return NULL;
        }
    }
    return z;
}

extern void danish_close_env(struct SN_env * z) {
    if (!z) return;
    lose_s(((SN_local *)z)->s_ch);
    SN_delete_env(z);
}

