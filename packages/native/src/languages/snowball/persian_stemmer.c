/*
 * Generated from algorithms/persian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "persian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int persian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 0x6A9 };
static const symbol s_1[] = { 0x6CC };
static const symbol s_2[] = { 0x647 };
static const symbol s_3[] = { 0x627 };
static const symbol s_4[] = { 0x648 };
static const symbol s_5[] = { 0x62E, 0x628, 0x631 };
static const symbol s_6[] = { 0x627, 0x633, 0x62A, 0x627, 0x62F };
static const symbol s_7[] = { 0x631, 0x641, 0x62A };
static const symbol s_8[] = { 0x62F };
static const symbol s_9[] = { 0x62A };

static const symbol s_0_1[1] = { ' ' };
static const symbol s_0_2[1] = { 0x623 };
static const symbol s_0_3[1] = { 0x624 };
static const symbol s_0_4[1] = { 0x625 };
static const symbol s_0_5[1] = { 0x626 };
static const symbol s_0_6[1] = { 0x629 };
static const symbol s_0_7[1] = { 0x643 };
static const symbol s_0_8[1] = { 0x64A };
static const symbol s_0_9[1] = { 0x6C1 };
static const symbol s_0_10[1] = { 0x200D };
static const struct among a_0[11] = {
{ 0, 0, 0, 7, 0},
{ 1, s_0_1, -1, 6, 0},
{ 1, s_0_2, -2, 4, 0},
{ 1, s_0_3, -3, 5, 0},
{ 1, s_0_4, -4, 4, 0},
{ 1, s_0_5, -5, 2, 0},
{ 1, s_0_6, -6, 3, 0},
{ 1, s_0_7, -7, 1, 0},
{ 1, s_0_8, -8, 2, 0},
{ 1, s_0_9, -9, 3, 0},
{ 1, s_0_10, -10, 6, 0}
};

static const symbol s_1_0[3] = { 0x645, 0x6CC, 0x200C };
static const symbol s_1_1[4] = { 0x646, 0x645, 0x6CC, 0x200C };
static const struct among a_1[2] = {
{ 3, s_1_0, 0, 2, 0},
{ 4, s_1_1, 0, 1, 0}
};

static const symbol s_2_0[4] = { 0x633, 0x62A, 0x627, 0x646 };
static const symbol s_2_1[3] = { 0x631, 0x627, 0x646 };
static const symbol s_2_2[3] = { 0x633, 0x627, 0x646 };
static const symbol s_2_3[3] = { 0x648, 0x627, 0x646 };
static const struct among a_2[4] = {
{ 4, s_2_0, 0, -1, 0},
{ 3, s_2_1, 0, -1, 0},
{ 3, s_2_2, 0, -1, 0},
{ 3, s_2_3, 0, -1, 0}
};

static const symbol s_3_0[9] = { 0x622, 0x630, 0x631, 0x628, 0x627, 0x6CC, 0x62C, 0x627, 0x646 };
static const symbol s_3_1[5] = { 0x647, 0x645, 0x62F, 0x627, 0x646 };
static const symbol s_3_2[6] = { 0x62E, 0x627, 0x646, 0x62F, 0x627, 0x646 };
static const symbol s_3_3[5] = { 0x632, 0x646, 0x62F, 0x627, 0x646 };
static const symbol s_3_4[5] = { 0x645, 0x6CC, 0x632, 0x627, 0x646 };
static const symbol s_3_5[6] = { 0x62F, 0x631, 0x62E, 0x634, 0x627, 0x646 };
static const symbol s_3_6[7] = { 0x622, 0x62A, 0x634, 0x641, 0x634, 0x627, 0x646 };
static const symbol s_3_7[4] = { 0x646, 0x634, 0x627, 0x646 };
static const symbol s_3_8[6] = { 0x6A9, 0x647, 0x6A9, 0x634, 0x627, 0x646 };
static const symbol s_3_9[5] = { 0x627, 0x6CC, 0x634, 0x627, 0x646 };
static const symbol s_3_10[6] = { 0x67E, 0x631, 0x6CC, 0x634, 0x627, 0x646 };
static const symbol s_3_11[5] = { 0x633, 0x644, 0x637, 0x627, 0x646 };
static const symbol s_3_12[5] = { 0x6AF, 0x6CC, 0x644, 0x627, 0x646 };
static const symbol s_3_13[7] = { 0x633, 0x627, 0x62E, 0x62A, 0x645, 0x627, 0x646 };
static const symbol s_3_14[4] = { 0x631, 0x645, 0x627, 0x646 };
static const symbol s_3_15[5] = { 0x62F, 0x631, 0x645, 0x627, 0x646 };
static const symbol s_3_16[6] = { 0x642, 0x647, 0x631, 0x645, 0x627, 0x646 };
static const symbol s_3_17[5] = { 0x6A9, 0x631, 0x645, 0x627, 0x646 };
static const symbol s_3_18[6] = { 0x633, 0x627, 0x632, 0x645, 0x627, 0x646 };
static const symbol s_3_19[6] = { 0x647, 0x645, 0x632, 0x645, 0x627, 0x646 };
static const symbol s_3_20[5] = { 0x622, 0x633, 0x645, 0x627, 0x646 };
static const symbol s_3_21[5] = { 0x622, 0x644, 0x645, 0x627, 0x646 };
static const symbol s_3_22[6] = { 0x645, 0x633, 0x644, 0x645, 0x627, 0x646 };
static const symbol s_3_23[5] = { 0x627, 0x6CC, 0x645, 0x627, 0x646 };
static const symbol s_3_24[6] = { 0x633, 0x644, 0x6CC, 0x645, 0x627, 0x646 };
static const symbol s_3_25[5] = { 0x67E, 0x6CC, 0x645, 0x627, 0x646 };
static const symbol s_3_26[5] = { 0x644, 0x628, 0x646, 0x627, 0x646 };
static const symbol s_3_27[5] = { 0x6CC, 0x648, 0x646, 0x627, 0x646 };
static const symbol s_3_28[6] = { 0x627, 0x635, 0x641, 0x647, 0x627, 0x646 };
static const symbol s_3_29[5] = { 0x627, 0x645, 0x6A9, 0x627, 0x646 };
static const symbol s_3_30[5] = { 0x67E, 0x627, 0x6CC, 0x627, 0x646 };
static const symbol s_3_31[4] = { 0x628, 0x6CC, 0x627, 0x646 };
static const symbol s_3_32[5] = { 0x62C, 0x631, 0x6CC, 0x627, 0x646 };
static const struct among a_3[33] = {
{ 9, s_3_0, 0, 1, 0},
{ 5, s_3_1, 0, 1, 0},
{ 6, s_3_2, 0, 1, 0},
{ 5, s_3_3, 0, 1, 0},
{ 5, s_3_4, 0, 1, 0},
{ 6, s_3_5, 0, 1, 0},
{ 7, s_3_6, 0, 1, 0},
{ 4, s_3_7, 0, 1, 0},
{ 6, s_3_8, 0, 1, 0},
{ 5, s_3_9, 0, 1, 0},
{ 6, s_3_10, 0, 1, 0},
{ 5, s_3_11, 0, 1, 0},
{ 5, s_3_12, 0, 1, 0},
{ 7, s_3_13, 0, 1, 0},
{ 4, s_3_14, 0, 1, 0},
{ 5, s_3_15, -1, 1, 0},
{ 6, s_3_16, -2, 1, 0},
{ 5, s_3_17, -3, 1, 0},
{ 6, s_3_18, 0, 1, 0},
{ 6, s_3_19, 0, 1, 0},
{ 5, s_3_20, 0, 1, 0},
{ 5, s_3_21, 0, 1, 0},
{ 6, s_3_22, 0, 1, 0},
{ 5, s_3_23, 0, 1, 0},
{ 6, s_3_24, 0, 1, 0},
{ 5, s_3_25, 0, 1, 0},
{ 5, s_3_26, 0, 1, 0},
{ 5, s_3_27, 0, 1, 0},
{ 6, s_3_28, 0, 1, 0},
{ 5, s_3_29, 0, 1, 0},
{ 5, s_3_30, 0, 1, 0},
{ 4, s_3_31, 0, 1, 0},
{ 5, s_3_32, 0, 1, 0}
};

static const symbol s_4_0[6] = { 0x627, 0x633, 0x627, 0x62A, 0x6CC, 0x62F };
static const symbol s_4_1[5] = { 0x627, 0x62E, 0x628, 0x627, 0x631 };
static const struct among a_4[2] = {
{ 6, s_4_0, 0, 2, 0},
{ 5, s_4_1, 0, 1, 0}
};

static const symbol s_5_0[2] = { 0x647, 0x627 };
static const symbol s_5_1[2] = { 0x627, 0x62A };
static const symbol s_5_2[2] = { 0x6CC, 0x62A };
static const symbol s_5_3[3] = { 0x645, 0x646, 0x62F };
static const symbol s_5_4[3] = { 0x648, 0x627, 0x631 };
static const symbol s_5_5[3] = { 0x6AF, 0x627, 0x631 };
static const symbol s_5_6[2] = { 0x62A, 0x631 };
static const symbol s_5_7[2] = { 0x627, 0x634 };
static const symbol s_5_8[2] = { 0x627, 0x645 };
static const symbol s_5_9[2] = { 0x627, 0x646 };
static const symbol s_5_10[3] = { 0x628, 0x627, 0x646 };
static const symbol s_5_11[3] = { 0x6AF, 0x627, 0x646 };
static const symbol s_5_12[3] = { 0x6CC, 0x627, 0x646 };
static const symbol s_5_13[2] = { 0x6CC, 0x646 };
static const symbol s_5_14[4] = { 0x62A, 0x631, 0x6CC, 0x646 };
static const symbol s_5_15[3] = { 0x6AF, 0x627, 0x647 };
static const symbol s_5_16[3] = { 0x627, 0x646, 0x647 };
static const symbol s_5_17[3] = { 0x646, 0x627, 0x6A9 };
static const symbol s_5_18[3] = { 0x647, 0x627, 0x6CC };
static const symbol s_5_19[3] = { 0x627, 0x646, 0x6CC };
static const symbol s_5_20[2] = { 0x6AF, 0x6CC };
static const symbol s_5_21[2] = { 0x6CC, 0x6CC };
static const struct among a_5[22] = {
{ 2, s_5_0, 0, 1, 0},
{ 2, s_5_1, 0, 1, 0},
{ 2, s_5_2, 0, 1, 0},
{ 3, s_5_3, 0, 1, 0},
{ 3, s_5_4, 0, 1, 0},
{ 3, s_5_5, 0, 1, 0},
{ 2, s_5_6, 0, 2, 0},
{ 2, s_5_7, 0, 1, 0},
{ 2, s_5_8, 0, 1, 0},
{ 2, s_5_9, 0, 1, 0},
{ 3, s_5_10, -1, 1, 0},
{ 3, s_5_11, -2, 1, 0},
{ 3, s_5_12, -3, 1, 0},
{ 2, s_5_13, 0, 1, 0},
{ 4, s_5_14, -1, 1, 0},
{ 3, s_5_15, 0, 1, 0},
{ 3, s_5_16, 0, 1, 0},
{ 3, s_5_17, 0, 1, 0},
{ 3, s_5_18, 0, 1, 0},
{ 3, s_5_19, 0, 1, 0},
{ 2, s_5_20, 0, 1, 0},
{ 2, s_5_21, 0, 1, 0}
};

static const symbol s_6_0[3] = { 0x627, 0x633, 0x62A };
static const symbol s_6_1[3] = { 0x627, 0x646, 0x62F };
static const symbol s_6_2[2] = { 0x6CC, 0x62F };
static const symbol s_6_3[3] = { 0x627, 0x6CC, 0x62F };
static const symbol s_6_4[2] = { 0x627, 0x633 };
static const symbol s_6_5[2] = { 0x6CC, 0x645 };
static const symbol s_6_6[3] = { 0x627, 0x6CC, 0x645 };
static const symbol s_6_7[2] = { 0x627, 0x6CC };
static const struct among a_6[8] = {
{ 3, s_6_0, 0, 1, 0},
{ 3, s_6_1, 0, 1, 0},
{ 2, s_6_2, 0, 1, 0},
{ 3, s_6_3, -1, 1, 0},
{ 2, s_6_4, 0, 1, 0},
{ 2, s_6_5, 0, 1, 0},
{ 3, s_6_6, -1, 1, 0},
{ 2, s_6_7, 0, 1, 0}
};

static const symbol s_7_0[1] = { 0x62F };
static const symbol s_7_1[3] = { 0x627, 0x646, 0x62F };
static const symbol s_7_2[6] = { 0x631, 0x641, 0x62A, 0x627, 0x646, 0x62F };
static const symbol s_7_3[2] = { 0x6CC, 0x62F };
static const symbol s_7_4[5] = { 0x631, 0x641, 0x62A, 0x6CC, 0x62F };
static const symbol s_7_5[1] = { 0x645 };
static const symbol s_7_6[2] = { 0x627, 0x645 };
static const symbol s_7_7[4] = { 0x631, 0x641, 0x62A, 0x645 };
static const symbol s_7_8[2] = { 0x6CC, 0x645 };
static const symbol s_7_9[5] = { 0x631, 0x641, 0x62A, 0x6CC, 0x645 };
static const symbol s_7_10[2] = { 0x627, 0x646 };
static const symbol s_7_11[2] = { 0x62A, 0x647 };
static const symbol s_7_12[2] = { 0x62F, 0x647 };
static const symbol s_7_13[3] = { 0x646, 0x62F, 0x647 };
static const symbol s_7_14[4] = { 0x631, 0x641, 0x62A, 0x6CC };
static const struct among a_7[15] = {
{ 1, s_7_0, 0, 1, 0},
{ 3, s_7_1, -1, 1, 0},
{ 6, s_7_2, -1, 2, 0},
{ 2, s_7_3, -3, 1, 0},
{ 5, s_7_4, -1, 2, 0},
{ 1, s_7_5, 0, 1, 0},
{ 2, s_7_6, -1, 1, 0},
{ 4, s_7_7, -2, 2, 0},
{ 2, s_7_8, -3, 1, 0},
{ 5, s_7_9, -1, 2, 0},
{ 2, s_7_10, 0, 3, 0},
{ 2, s_7_11, 0, 5, 0},
{ 2, s_7_12, 0, 4, 0},
{ 3, s_7_13, -1, 3, 0},
{ 4, s_7_14, 0, 2, 0}
};

extern int persian_stem(struct SN_env * z) {
    int among_var;
    int i_p1;
    int b_remove_verb_person_endings;
    int b_saw_present_prefix;
    b_saw_present_prefix = 0;
    {
        int v_1 = z->c;
        while (1) {
            int v_2 = z->c;
            z->bra = z->c;
            among_var = find_among(z, a_0, 11, 0);
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
                case 3:
                    {
                        int ret = slice_from_s(z, 1, s_2);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    {
                        int ret = slice_from_s(z, 1, s_3);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    {
                        int ret = slice_from_s(z, 1, s_4);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 7:
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
    {
        int v_3 = z->c;
        z->bra = z->c;
        if (z->c + 2 >= z->l || (z->p[z->c + 2] != 8204 && z->p[z->c + 2] != 1740)) goto lab2;
        among_var = find_among(z, a_1, 2, 0);
        if (!among_var) goto lab2;
        z->ket = z->c;
        switch (among_var) {
            case 1:
                if (z->c + 2 > z->l) goto lab2;
                z->c += 2;
                b_saw_present_prefix = 1;
                break;
            case 2:
                if (z->c + 2 > z->l) goto lab2;
                z->c += 2;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                b_saw_present_prefix = 1;
                break;
        }
    lab2:
        z->c = v_3;
    }
    {
        int v_4 = z->c;
        while (1) {
            int v_5 = z->c;
            while (1) {
                int v_6 = z->c;
                z->bra = z->c;
                if (z->c == z->l || z->p[z->c] != 0x200C) goto lab5;
                z->c++;
                z->ket = z->c;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                z->c = v_6;
                break;
            lab5:
                z->c = v_6;
                if (z->c >= z->l) goto lab4;
                z->c++;
            }
            continue;
        lab4:
            z->c = v_5;
            break;
        }
        z->c = v_4;
    }
    i_p1 = z->l;
    {
        int v_7 = z->c;
        if (z->c + 3 > z->l) goto lab6;
        z->c += 3;
        i_p1 = z->c;
    lab6:
        z->c = v_7;
    }
    z->lb = z->c; z->c = z->l;
    while (1) {
        int v_8 = z->l - z->c;
        {
            int v_9 = z->l - z->c;
            b_remove_verb_person_endings = 0;
            if (!b_saw_present_prefix) goto lab8;
            b_remove_verb_person_endings = 1;
        lab8:
            {
                int v_10 = z->l - z->c;
                if (z->c - 3 <= z->lb || z->p[z->c - 1] != 1606) goto lab9;
                if (!find_among_b(z, a_3, 33, 0)) goto lab9;
                if (z->c > z->lb) goto lab9;
                goto lab7;
            lab9:
                z->c = z->l - v_10;
            }
            {
                int v_11 = z->l - z->c;
                if (z->c - 2 <= z->lb || z->p[z->c - 1] != 1606) goto lab10;
                if (!find_among_b(z, a_2, 4, 0)) goto lab10;
                goto lab7;
            lab10:
                z->c = z->l - v_11;
            }
            do {
                int v_12 = z->l - z->c;
                do {
                    int v_13 = z->l - z->c;
                    z->ket = z->c;
                    if (z->c - 4 <= z->lb || (z->p[z->c - 1] != 1583 && z->p[z->c - 1] != 1585)) goto lab12;
                    among_var = find_among_b(z, a_4, 2, 0);
                    if (!among_var) goto lab12;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            {
                                int ret = slice_from_s(z, 3, s_5);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            {
                                int ret = slice_from_s(z, 5, s_6);
                                if (ret < 0) return ret;
                            }
                            break;
                    }
                    break;
                lab12:
                    z->c = z->l - v_13;
                    {
                        int v_14;
                        if (z->c < i_p1) goto lab11;
                        v_14 = z->lb; z->lb = i_p1;
                        z->ket = z->c;
                        among_var = find_among_b(z, a_5, 22, 0);
                        if (!among_var) { z->lb = v_14; goto lab11; }
                        z->bra = z->c;
                        switch (among_var) {
                            case 1:
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                            case 2:
                                if (z->c <= z->lb) { z->lb = v_14; goto lab11; }
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                        }
                        z->lb = v_14;
                    }
                } while (0);
                break;
            lab11:
                z->c = z->l - v_12;
                do {
                    int v_15 = z->l - z->c;
                    z->ket = z->c;
                    if (!find_among_b(z, a_6, 8, 0)) goto lab13;
                    z->bra = z->c;
                    if (i_p1 > z->c) goto lab13;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab13:
                    z->c = z->l - v_15;
                    z->ket = z->c;
                    among_var = find_among_b(z, a_7, 15, 0);
                    if (!among_var) goto lab7;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            if (!b_remove_verb_person_endings) goto lab7;
                            if (i_p1 > z->c) goto lab7;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            {
                                int ret = slice_from_s(z, 3, s_7);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 3:
                            if (i_p1 > z->c) goto lab7;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            b_remove_verb_person_endings = 1;
                            break;
                        case 4:
                            if (z->c <= z->lb) goto lab7;
                            {
                                int ret = slice_from_s(z, 1, s_8);
                                if (ret < 0) return ret;
                            }
                            b_remove_verb_person_endings = 1;
                            break;
                        case 5:
                            if (z->c <= z->lb) goto lab7;
                            {
                                int ret = slice_from_s(z, 1, s_9);
                                if (ret < 0) return ret;
                            }
                            b_remove_verb_person_endings = 1;
                            break;
                    }
                } while (0);
            } while (0);
            z->c = z->l - v_9;
        }
        continue;
    lab7:
        z->c = z->l - v_8;
        break;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * persian_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
