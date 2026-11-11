/*
 * Generated from algorithms/indonesian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "indonesian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

struct SN_local {
    struct SN_env z;
    int i_prefix;
    int i_measure;
};

typedef struct SN_local SN_local;

#ifdef __cplusplus
extern "C" {
#endif
extern int indonesian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_remove_suffix(struct SN_env * z);
static int r_remove_second_order_prefix(struct SN_env * z);

static const symbol s_0[] = { 'a', 'j', 'a', 'r' };
static const symbol s_1[] = { 'a', 'j', 'a', 'r' };
static const symbol s_2[] = { 'e', 'r' };
static const symbol s_3[] = { 's' };
static const symbol s_4[] = { 's' };
static const symbol s_5[] = { 'p' };
static const symbol s_6[] = { 'p' };

static const symbol s_0_0[3] = { 'k', 'a', 'h' };
static const symbol s_0_1[3] = { 'l', 'a', 'h' };
static const symbol s_0_2[3] = { 'p', 'u', 'n' };
static const struct among a_0[3] = {
{ 3, s_0_0, 0, 1, 0},
{ 3, s_0_1, 0, 1, 0},
{ 3, s_0_2, 0, 1, 0}
};

static const symbol s_1_0[3] = { 'n', 'y', 'a' };
static const symbol s_1_1[2] = { 'k', 'u' };
static const symbol s_1_2[2] = { 'm', 'u' };
static const struct among a_1[3] = {
{ 3, s_1_0, 0, 1, 0},
{ 2, s_1_1, 0, 1, 0},
{ 2, s_1_2, 0, 1, 0}
};

static const symbol s_2_0[1] = { 'i' };
static const symbol s_2_1[2] = { 'a', 'n' };
static const struct among a_2[2] = {
{ 1, s_2_0, 0, 2, 0},
{ 2, s_2_1, 0, 1, 0}
};

static const symbol s_3_0[2] = { 'd', 'i' };
static const symbol s_3_1[2] = { 'k', 'e' };
static const symbol s_3_2[2] = { 'm', 'e' };
static const symbol s_3_3[3] = { 'm', 'e', 'm' };
static const symbol s_3_4[3] = { 'm', 'e', 'n' };
static const symbol s_3_5[4] = { 'm', 'e', 'n', 'g' };
static const symbol s_3_6[3] = { 'p', 'e', 'm' };
static const symbol s_3_7[3] = { 'p', 'e', 'n' };
static const symbol s_3_8[4] = { 'p', 'e', 'n', 'g' };
static const symbol s_3_9[3] = { 't', 'e', 'r' };
static const struct among a_3[10] = {
{ 2, s_3_0, 0, 1, 0},
{ 2, s_3_1, 0, 3, 0},
{ 2, s_3_2, 0, 1, 0},
{ 3, s_3_3, -1, 5, 0},
{ 3, s_3_4, -2, 2, 0},
{ 4, s_3_5, -1, 1, 0},
{ 3, s_3_6, 0, 6, 0},
{ 3, s_3_7, 0, 4, 0},
{ 4, s_3_8, -1, 3, 0},
{ 3, s_3_9, 0, 1, 0}
};

static const symbol s_4_0[2] = { 'b', 'e' };
static const symbol s_4_1[2] = { 'p', 'e' };
static const struct among a_4[2] = {
{ 2, s_4_0, 0, 2, 0},
{ 2, s_4_1, 0, 1, 0}
};

static const unsigned char g_vowel[] = { 17, 65, 16 };

static int r_remove_suffix(struct SN_env * z) {
    int among_var;
    z->ket = z->c;
    if (z->c <= z->lb || (z->p[z->c - 1] != 105 && z->p[z->c - 1] != 110)) return 0;
    among_var = find_among_b(z, a_2, 2, 0);
    if (!among_var) return 0;
    z->bra = z->c;
    switch (among_var) {
        case 1:
            do {
                int v_1 = z->l - z->c;
                if (((SN_local *)z)->i_prefix == 3) goto lab0;
                if (((SN_local *)z)->i_prefix == 2) goto lab0;
                if (z->c <= z->lb || z->p[z->c - 1] != 'k') goto lab0;
                z->c--;
                z->bra = z->c;
                break;
            lab0:
                z->c = z->l - v_1;
                if (((SN_local *)z)->i_prefix == 1) return 0;
            } while (0);
            break;
        case 2:
            if (((SN_local *)z)->i_prefix > 2) return 0;
            if (z->c <= z->lb || z->p[z->c - 1] != 's') goto lab1;
            z->c--;
            return 0;
        lab1:
            break;
    }
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    ((SN_local *)z)->i_measure -= 1;
    return 1;
}

static int r_remove_second_order_prefix(struct SN_env * z) {
    int among_var;
    z->bra = z->c;
    if (z->c + 1 >= z->l || z->p[z->c + 1] != 101) return 0;
    among_var = find_among(z, a_4, 2, 0);
    if (!among_var) return 0;
    switch (among_var) {
        case 1:
            do {
                int v_1 = z->c;
                if (z->c == z->l || z->p[z->c] != 'r') goto lab0;
                z->c++;
                z->ket = z->c;
                ((SN_local *)z)->i_prefix = 2;
                break;
            lab0:
                z->c = v_1;
                if (z->c == z->l || z->p[z->c] != 'l') goto lab1;
                z->c++;
                z->ket = z->c;
                if (!(eq_s(z, 4, s_0))) goto lab1;
                break;
            lab1:
                z->c = v_1;
                z->ket = z->c;
                ((SN_local *)z)->i_prefix = 2;
            } while (0);
            break;
        case 2:
            do {
                int v_2 = z->c;
                if (z->c == z->l || z->p[z->c] != 'r') goto lab2;
                z->c++;
                z->ket = z->c;
                break;
            lab2:
                z->c = v_2;
                if (z->c == z->l || z->p[z->c] != 'l') goto lab3;
                z->c++;
                z->ket = z->c;
                if (!(eq_s(z, 4, s_1))) goto lab3;
                break;
            lab3:
                z->c = v_2;
                z->ket = z->c;
                if (out_grouping(z, g_vowel, 97, 117, 0)) return 0;
                if (!(eq_s(z, 2, s_2))) return 0;
            } while (0);
            ((SN_local *)z)->i_prefix = 4;
            break;
    }
    ((SN_local *)z)->i_measure -= 1;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    return 1;
}

extern int indonesian_stem(struct SN_env * z) {
    int among_var;
    ((SN_local *)z)->i_measure = 0;
    {
        int v_1 = z->c;
        while (1) {
            int v_2 = z->c;
            {
                int ret = out_grouping(z, g_vowel, 97, 117, 1);
                if (ret < 0) goto lab1;
                z->c += ret;
            }
            ((SN_local *)z)->i_measure += 1;
            continue;
        lab1:
            z->c = v_2;
            break;
        }
        z->c = v_1;
    }
    if (((SN_local *)z)->i_measure < 3) return 0;
    ((SN_local *)z)->i_prefix = 0;
    z->lb = z->c; z->c = z->l;
    {
        int v_3 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 2 <= z->lb || (z->p[z->c - 1] != 104 && z->p[z->c - 1] != 110)) goto lab2;
        if (!find_among_b(z, a_0, 3, 0)) goto lab2;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        ((SN_local *)z)->i_measure -= 1;
    lab2:
        z->c = z->l - v_3;
    }
    if (((SN_local *)z)->i_measure < 3) return 0;
    {
        int v_4 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 97 && z->p[z->c - 1] != 117)) goto lab3;
        if (!find_among_b(z, a_1, 3, 0)) goto lab3;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        ((SN_local *)z)->i_measure -= 1;
    lab3:
        z->c = z->l - v_4;
    }
    z->c = z->lb;
    if (((SN_local *)z)->i_measure < 3) return 0;
    do {
        int v_5 = z->c;
        {
            int v_6 = z->c;
            z->bra = z->c;
            if (z->c + 1 >= z->l || (z->p[z->c + 1] != 105 && z->p[z->c + 1] != 101)) goto lab4;
            among_var = find_among(z, a_3, 10, 0);
            if (!among_var) goto lab4;
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    ((SN_local *)z)->i_prefix = 1;
                    ((SN_local *)z)->i_measure -= 1;
                    break;
                case 2:
                    do {
                        int v_7 = z->c;
                        if (z->c == z->l || z->p[z->c] != 'y') goto lab5;
                        z->c++;
                        {
                            int v_8 = z->c;
                            if (in_grouping(z, g_vowel, 97, 117, 0)) goto lab5;
                            z->c = v_8;
                        }
                        z->ket = z->c;
                        {
                            int ret = slice_from_s(z, 1, s_3);
                            if (ret < 0) return ret;
                        }
                        ((SN_local *)z)->i_prefix = 1;
                        ((SN_local *)z)->i_measure -= 1;
                        break;
                    lab5:
                        z->c = v_7;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        ((SN_local *)z)->i_prefix = 1;
                        ((SN_local *)z)->i_measure -= 1;
                    } while (0);
                    break;
                case 3:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    ((SN_local *)z)->i_prefix = 3;
                    ((SN_local *)z)->i_measure -= 1;
                    break;
                case 4:
                    do {
                        int v_9 = z->c;
                        if (z->c == z->l || z->p[z->c] != 'y') goto lab6;
                        z->c++;
                        {
                            int v_10 = z->c;
                            if (in_grouping(z, g_vowel, 97, 117, 0)) goto lab6;
                            z->c = v_10;
                        }
                        z->ket = z->c;
                        {
                            int ret = slice_from_s(z, 1, s_4);
                            if (ret < 0) return ret;
                        }
                        ((SN_local *)z)->i_prefix = 3;
                        ((SN_local *)z)->i_measure -= 1;
                        break;
                    lab6:
                        z->c = v_9;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                        ((SN_local *)z)->i_prefix = 3;
                        ((SN_local *)z)->i_measure -= 1;
                    } while (0);
                    break;
                case 5:
                    ((SN_local *)z)->i_prefix = 1;
                    ((SN_local *)z)->i_measure -= 1;
                    do {
                        int v_11 = z->c;
                        {
                            int v_12 = z->c;
                            if (in_grouping(z, g_vowel, 97, 117, 0)) goto lab7;
                            z->c = v_12;
                            {
                                int ret = slice_from_s(z, 1, s_5);
                                if (ret < 0) return ret;
                            }
                        }
                        break;
                    lab7:
                        z->c = v_11;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    } while (0);
                    break;
                case 6:
                    ((SN_local *)z)->i_prefix = 3;
                    ((SN_local *)z)->i_measure -= 1;
                    do {
                        int v_13 = z->c;
                        {
                            int v_14 = z->c;
                            if (in_grouping(z, g_vowel, 97, 117, 0)) goto lab8;
                            z->c = v_14;
                            {
                                int ret = slice_from_s(z, 1, s_6);
                                if (ret < 0) return ret;
                            }
                        }
                        break;
                    lab8:
                        z->c = v_13;
                        {
                            int ret = slice_del(z);
                            if (ret < 0) return ret;
                        }
                    } while (0);
                    break;
            }
            {
                int v_15 = z->c;
                {
                    int v_16 = z->c;
                    if (((SN_local *)z)->i_measure < 3) goto lab9;
                    z->lb = z->c; z->c = z->l;
                    {
                        int ret = r_remove_suffix(z);
                        if (ret == 0) goto lab9;
                        if (ret < 0) return ret;
                    }
                    z->c = z->lb;
                    z->c = v_16;
                }
                if (((SN_local *)z)->i_measure < 3) goto lab9;
                {
                    int ret = r_remove_second_order_prefix(z);
                    if (ret == 0) goto lab9;
                    if (ret < 0) return ret;
                }
            lab9:
                z->c = v_15;
            }
            z->c = v_6;
        }
        break;
    lab4:
        z->c = v_5;
        {
            int v_17 = z->c;
            {
                int ret = r_remove_second_order_prefix(z);
                if (ret < 0) return ret;
            }
            z->c = v_17;
        }
        {
            int v_18 = z->c;
            if (((SN_local *)z)->i_measure < 3) goto lab10;
            z->lb = z->c; z->c = z->l;
            {
                int ret = r_remove_suffix(z);
                if (ret == 0) goto lab10;
                if (ret < 0) return ret;
            }
            z->c = z->lb;
        lab10:
            z->c = v_18;
        }
    } while (0);
    return 1;
}

extern struct SN_env * indonesian_create_env(void) {
    return SN_new_env(sizeof(SN_local));
}
