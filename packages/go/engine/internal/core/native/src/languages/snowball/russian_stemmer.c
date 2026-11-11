/*
 * Generated from algorithms/russian.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "russian_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int russian_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 0x435 };

static const symbol s_0_0[1] = { 0x432 };
static const symbol s_0_1[2] = { 0x438, 0x432 };
static const symbol s_0_2[2] = { 0x44B, 0x432 };
static const symbol s_0_3[3] = { 0x432, 0x448, 0x438 };
static const symbol s_0_4[4] = { 0x438, 0x432, 0x448, 0x438 };
static const symbol s_0_5[4] = { 0x44B, 0x432, 0x448, 0x438 };
static const symbol s_0_6[5] = { 0x432, 0x448, 0x438, 0x441, 0x44C };
static const symbol s_0_7[6] = { 0x438, 0x432, 0x448, 0x438, 0x441, 0x44C };
static const symbol s_0_8[6] = { 0x44B, 0x432, 0x448, 0x438, 0x441, 0x44C };
static const struct among a_0[9] = {
{ 1, s_0_0, 0, 1, 0},
{ 2, s_0_1, -1, 2, 0},
{ 2, s_0_2, -2, 2, 0},
{ 3, s_0_3, 0, 1, 0},
{ 4, s_0_4, -1, 2, 0},
{ 4, s_0_5, -2, 2, 0},
{ 5, s_0_6, 0, 1, 0},
{ 6, s_0_7, -1, 2, 0},
{ 6, s_0_8, -2, 2, 0}
};

static const symbol s_1_0[2] = { 0x435, 0x435 };
static const symbol s_1_1[2] = { 0x438, 0x435 };
static const symbol s_1_2[2] = { 0x43E, 0x435 };
static const symbol s_1_3[2] = { 0x44B, 0x435 };
static const symbol s_1_4[3] = { 0x438, 0x43C, 0x438 };
static const symbol s_1_5[3] = { 0x44B, 0x43C, 0x438 };
static const symbol s_1_6[2] = { 0x435, 0x439 };
static const symbol s_1_7[2] = { 0x438, 0x439 };
static const symbol s_1_8[2] = { 0x43E, 0x439 };
static const symbol s_1_9[2] = { 0x44B, 0x439 };
static const symbol s_1_10[2] = { 0x435, 0x43C };
static const symbol s_1_11[2] = { 0x438, 0x43C };
static const symbol s_1_12[2] = { 0x43E, 0x43C };
static const symbol s_1_13[2] = { 0x44B, 0x43C };
static const symbol s_1_14[3] = { 0x435, 0x433, 0x43E };
static const symbol s_1_15[3] = { 0x43E, 0x433, 0x43E };
static const symbol s_1_16[3] = { 0x435, 0x43C, 0x443 };
static const symbol s_1_17[3] = { 0x43E, 0x43C, 0x443 };
static const symbol s_1_18[2] = { 0x438, 0x445 };
static const symbol s_1_19[2] = { 0x44B, 0x445 };
static const symbol s_1_20[2] = { 0x435, 0x44E };
static const symbol s_1_21[2] = { 0x43E, 0x44E };
static const symbol s_1_22[2] = { 0x443, 0x44E };
static const symbol s_1_23[2] = { 0x44E, 0x44E };
static const symbol s_1_24[2] = { 0x430, 0x44F };
static const symbol s_1_25[2] = { 0x44F, 0x44F };
static const struct among a_1[26] = {
{ 2, s_1_0, 0, 1, 0},
{ 2, s_1_1, 0, 1, 0},
{ 2, s_1_2, 0, 1, 0},
{ 2, s_1_3, 0, 1, 0},
{ 3, s_1_4, 0, 1, 0},
{ 3, s_1_5, 0, 1, 0},
{ 2, s_1_6, 0, 1, 0},
{ 2, s_1_7, 0, 1, 0},
{ 2, s_1_8, 0, 1, 0},
{ 2, s_1_9, 0, 1, 0},
{ 2, s_1_10, 0, 1, 0},
{ 2, s_1_11, 0, 1, 0},
{ 2, s_1_12, 0, 1, 0},
{ 2, s_1_13, 0, 1, 0},
{ 3, s_1_14, 0, 1, 0},
{ 3, s_1_15, 0, 1, 0},
{ 3, s_1_16, 0, 1, 0},
{ 3, s_1_17, 0, 1, 0},
{ 2, s_1_18, 0, 1, 0},
{ 2, s_1_19, 0, 1, 0},
{ 2, s_1_20, 0, 1, 0},
{ 2, s_1_21, 0, 1, 0},
{ 2, s_1_22, 0, 1, 0},
{ 2, s_1_23, 0, 1, 0},
{ 2, s_1_24, 0, 1, 0},
{ 2, s_1_25, 0, 1, 0}
};

static const symbol s_2_0[2] = { 0x435, 0x43C };
static const symbol s_2_1[2] = { 0x43D, 0x43D };
static const symbol s_2_2[2] = { 0x432, 0x448 };
static const symbol s_2_3[3] = { 0x438, 0x432, 0x448 };
static const symbol s_2_4[3] = { 0x44B, 0x432, 0x448 };
static const symbol s_2_5[1] = { 0x449 };
static const symbol s_2_6[2] = { 0x44E, 0x449 };
static const symbol s_2_7[3] = { 0x443, 0x44E, 0x449 };
static const struct among a_2[8] = {
{ 2, s_2_0, 0, 1, 0},
{ 2, s_2_1, 0, 1, 0},
{ 2, s_2_2, 0, 1, 0},
{ 3, s_2_3, -1, 2, 0},
{ 3, s_2_4, -2, 2, 0},
{ 1, s_2_5, 0, 1, 0},
{ 2, s_2_6, -1, 1, 0},
{ 3, s_2_7, -1, 2, 0}
};

static const symbol s_3_0[2] = { 0x441, 0x44C };
static const symbol s_3_1[2] = { 0x441, 0x44F };
static const struct among a_3[2] = {
{ 2, s_3_0, 0, 1, 0},
{ 2, s_3_1, 0, 1, 0}
};

static const symbol s_4_0[2] = { 0x43B, 0x430 };
static const symbol s_4_1[3] = { 0x438, 0x43B, 0x430 };
static const symbol s_4_2[3] = { 0x44B, 0x43B, 0x430 };
static const symbol s_4_3[2] = { 0x43D, 0x430 };
static const symbol s_4_4[3] = { 0x435, 0x43D, 0x430 };
static const symbol s_4_5[3] = { 0x435, 0x442, 0x435 };
static const symbol s_4_6[3] = { 0x438, 0x442, 0x435 };
static const symbol s_4_7[3] = { 0x439, 0x442, 0x435 };
static const symbol s_4_8[4] = { 0x435, 0x439, 0x442, 0x435 };
static const symbol s_4_9[4] = { 0x443, 0x439, 0x442, 0x435 };
static const symbol s_4_10[2] = { 0x43B, 0x438 };
static const symbol s_4_11[3] = { 0x438, 0x43B, 0x438 };
static const symbol s_4_12[3] = { 0x44B, 0x43B, 0x438 };
static const symbol s_4_13[1] = { 0x439 };
static const symbol s_4_14[2] = { 0x435, 0x439 };
static const symbol s_4_15[2] = { 0x443, 0x439 };
static const symbol s_4_16[1] = { 0x43B };
static const symbol s_4_17[2] = { 0x438, 0x43B };
static const symbol s_4_18[2] = { 0x44B, 0x43B };
static const symbol s_4_19[2] = { 0x435, 0x43C };
static const symbol s_4_20[2] = { 0x438, 0x43C };
static const symbol s_4_21[2] = { 0x44B, 0x43C };
static const symbol s_4_22[1] = { 0x43D };
static const symbol s_4_23[2] = { 0x435, 0x43D };
static const symbol s_4_24[2] = { 0x43B, 0x43E };
static const symbol s_4_25[3] = { 0x438, 0x43B, 0x43E };
static const symbol s_4_26[3] = { 0x44B, 0x43B, 0x43E };
static const symbol s_4_27[2] = { 0x43D, 0x43E };
static const symbol s_4_28[3] = { 0x435, 0x43D, 0x43E };
static const symbol s_4_29[3] = { 0x43D, 0x43D, 0x43E };
static const symbol s_4_30[2] = { 0x435, 0x442 };
static const symbol s_4_31[3] = { 0x443, 0x435, 0x442 };
static const symbol s_4_32[2] = { 0x438, 0x442 };
static const symbol s_4_33[2] = { 0x44B, 0x442 };
static const symbol s_4_34[2] = { 0x44E, 0x442 };
static const symbol s_4_35[3] = { 0x443, 0x44E, 0x442 };
static const symbol s_4_36[2] = { 0x44F, 0x442 };
static const symbol s_4_37[2] = { 0x43D, 0x44B };
static const symbol s_4_38[3] = { 0x435, 0x43D, 0x44B };
static const symbol s_4_39[2] = { 0x442, 0x44C };
static const symbol s_4_40[3] = { 0x438, 0x442, 0x44C };
static const symbol s_4_41[3] = { 0x44B, 0x442, 0x44C };
static const symbol s_4_42[3] = { 0x435, 0x448, 0x44C };
static const symbol s_4_43[3] = { 0x438, 0x448, 0x44C };
static const symbol s_4_44[1] = { 0x44E };
static const symbol s_4_45[2] = { 0x443, 0x44E };
static const struct among a_4[46] = {
{ 2, s_4_0, 0, 1, 0},
{ 3, s_4_1, -1, 2, 0},
{ 3, s_4_2, -2, 2, 0},
{ 2, s_4_3, 0, 1, 0},
{ 3, s_4_4, -1, 2, 0},
{ 3, s_4_5, 0, 1, 0},
{ 3, s_4_6, 0, 2, 0},
{ 3, s_4_7, 0, 1, 0},
{ 4, s_4_8, -1, 2, 0},
{ 4, s_4_9, -2, 2, 0},
{ 2, s_4_10, 0, 1, 0},
{ 3, s_4_11, -1, 2, 0},
{ 3, s_4_12, -2, 2, 0},
{ 1, s_4_13, 0, 1, 0},
{ 2, s_4_14, -1, 2, 0},
{ 2, s_4_15, -2, 2, 0},
{ 1, s_4_16, 0, 1, 0},
{ 2, s_4_17, -1, 2, 0},
{ 2, s_4_18, -2, 2, 0},
{ 2, s_4_19, 0, 1, 0},
{ 2, s_4_20, 0, 2, 0},
{ 2, s_4_21, 0, 2, 0},
{ 1, s_4_22, 0, 1, 0},
{ 2, s_4_23, -1, 2, 0},
{ 2, s_4_24, 0, 1, 0},
{ 3, s_4_25, -1, 2, 0},
{ 3, s_4_26, -2, 2, 0},
{ 2, s_4_27, 0, 1, 0},
{ 3, s_4_28, -1, 2, 0},
{ 3, s_4_29, -2, 1, 0},
{ 2, s_4_30, 0, 1, 0},
{ 3, s_4_31, -1, 2, 0},
{ 2, s_4_32, 0, 2, 0},
{ 2, s_4_33, 0, 2, 0},
{ 2, s_4_34, 0, 1, 0},
{ 3, s_4_35, -1, 2, 0},
{ 2, s_4_36, 0, 2, 0},
{ 2, s_4_37, 0, 1, 0},
{ 3, s_4_38, -1, 2, 0},
{ 2, s_4_39, 0, 1, 0},
{ 3, s_4_40, -1, 2, 0},
{ 3, s_4_41, -2, 2, 0},
{ 3, s_4_42, 0, 1, 0},
{ 3, s_4_43, 0, 2, 0},
{ 1, s_4_44, 0, 2, 0},
{ 2, s_4_45, -1, 2, 0}
};

static const symbol s_5_0[1] = { 0x430 };
static const symbol s_5_1[2] = { 0x435, 0x432 };
static const symbol s_5_2[2] = { 0x43E, 0x432 };
static const symbol s_5_3[1] = { 0x435 };
static const symbol s_5_4[2] = { 0x438, 0x435 };
static const symbol s_5_5[2] = { 0x44C, 0x435 };
static const symbol s_5_6[1] = { 0x438 };
static const symbol s_5_7[2] = { 0x435, 0x438 };
static const symbol s_5_8[2] = { 0x438, 0x438 };
static const symbol s_5_9[3] = { 0x430, 0x43C, 0x438 };
static const symbol s_5_10[3] = { 0x44F, 0x43C, 0x438 };
static const symbol s_5_11[4] = { 0x438, 0x44F, 0x43C, 0x438 };
static const symbol s_5_12[1] = { 0x439 };
static const symbol s_5_13[2] = { 0x435, 0x439 };
static const symbol s_5_14[3] = { 0x438, 0x435, 0x439 };
static const symbol s_5_15[2] = { 0x438, 0x439 };
static const symbol s_5_16[2] = { 0x43E, 0x439 };
static const symbol s_5_17[2] = { 0x430, 0x43C };
static const symbol s_5_18[2] = { 0x435, 0x43C };
static const symbol s_5_19[3] = { 0x438, 0x435, 0x43C };
static const symbol s_5_20[2] = { 0x43E, 0x43C };
static const symbol s_5_21[2] = { 0x44F, 0x43C };
static const symbol s_5_22[3] = { 0x438, 0x44F, 0x43C };
static const symbol s_5_23[1] = { 0x43E };
static const symbol s_5_24[1] = { 0x443 };
static const symbol s_5_25[2] = { 0x430, 0x445 };
static const symbol s_5_26[2] = { 0x44F, 0x445 };
static const symbol s_5_27[3] = { 0x438, 0x44F, 0x445 };
static const symbol s_5_28[1] = { 0x44B };
static const symbol s_5_29[1] = { 0x44C };
static const symbol s_5_30[1] = { 0x44E };
static const symbol s_5_31[2] = { 0x438, 0x44E };
static const symbol s_5_32[2] = { 0x44C, 0x44E };
static const symbol s_5_33[1] = { 0x44F };
static const symbol s_5_34[2] = { 0x438, 0x44F };
static const symbol s_5_35[2] = { 0x44C, 0x44F };
static const struct among a_5[36] = {
{ 1, s_5_0, 0, 1, 0},
{ 2, s_5_1, 0, 1, 0},
{ 2, s_5_2, 0, 1, 0},
{ 1, s_5_3, 0, 1, 0},
{ 2, s_5_4, -1, 1, 0},
{ 2, s_5_5, -2, 1, 0},
{ 1, s_5_6, 0, 1, 0},
{ 2, s_5_7, -1, 1, 0},
{ 2, s_5_8, -2, 1, 0},
{ 3, s_5_9, -3, 1, 0},
{ 3, s_5_10, -4, 1, 0},
{ 4, s_5_11, -1, 1, 0},
{ 1, s_5_12, 0, 1, 0},
{ 2, s_5_13, -1, 1, 0},
{ 3, s_5_14, -1, 1, 0},
{ 2, s_5_15, -3, 1, 0},
{ 2, s_5_16, -4, 1, 0},
{ 2, s_5_17, 0, 1, 0},
{ 2, s_5_18, 0, 1, 0},
{ 3, s_5_19, -1, 1, 0},
{ 2, s_5_20, 0, 1, 0},
{ 2, s_5_21, 0, 1, 0},
{ 3, s_5_22, -1, 1, 0},
{ 1, s_5_23, 0, 1, 0},
{ 1, s_5_24, 0, 1, 0},
{ 2, s_5_25, 0, 1, 0},
{ 2, s_5_26, 0, 1, 0},
{ 3, s_5_27, -1, 1, 0},
{ 1, s_5_28, 0, 1, 0},
{ 1, s_5_29, 0, 1, 0},
{ 1, s_5_30, 0, 1, 0},
{ 2, s_5_31, -1, 1, 0},
{ 2, s_5_32, -2, 1, 0},
{ 1, s_5_33, 0, 1, 0},
{ 2, s_5_34, -1, 1, 0},
{ 2, s_5_35, -2, 1, 0}
};

static const symbol s_6_0[3] = { 0x43E, 0x441, 0x442 };
static const symbol s_6_1[4] = { 0x43E, 0x441, 0x442, 0x44C };
static const struct among a_6[2] = {
{ 3, s_6_0, 0, 1, 0},
{ 4, s_6_1, 0, 1, 0}
};

static const symbol s_7_0[4] = { 0x435, 0x439, 0x448, 0x435 };
static const symbol s_7_1[1] = { 0x43D };
static const symbol s_7_2[3] = { 0x435, 0x439, 0x448 };
static const symbol s_7_3[1] = { 0x44C };
static const struct among a_7[4] = {
{ 4, s_7_0, 0, 1, 0},
{ 1, s_7_1, 0, 2, 0},
{ 3, s_7_2, 0, 1, 0},
{ 1, s_7_3, 0, 3, 0}
};

static const unsigned char g_v[] = { 33, 65, 8, 232 };

extern int russian_stem(struct SN_env * z) {
    int among_var;
    int i_p2;
    int i_pV;
    {
        int v_1 = z->c;
        while (1) {
            int v_2 = z->c;
            while (1) {
                int v_3 = z->c;
                z->bra = z->c;
                if (z->c == z->l || z->p[z->c] != 0x451) goto lab2;
                z->c++;
                z->ket = z->c;
                z->c = v_3;
                break;
            lab2:
                z->c = v_3;
                if (z->c >= z->l) goto lab1;
                z->c++;
            }
            {
                int ret = slice_from_s(z, 1, s_0);
                if (ret < 0) return ret;
            }
            continue;
        lab1:
            z->c = v_2;
            break;
        }
        z->c = v_1;
    }
    i_pV = z->l;
    i_p2 = z->l;
    {
        int v_4 = z->c;
        {
            int ret = out_grouping(z, g_v, 1072, 1103, 1);
            if (ret < 0) goto lab4;
            z->c += ret;
        }
        i_pV = z->c;
        {
            int ret = in_grouping(z, g_v, 1072, 1103, 1);
            if (ret < 0) goto lab4;
            z->c += ret;
        }
        {
            int ret = out_grouping(z, g_v, 1072, 1103, 1);
            if (ret < 0) goto lab4;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 1072, 1103, 1);
            if (ret < 0) goto lab4;
            z->c += ret;
        }
        i_p2 = z->c;
    lab4:
        z->c = v_4;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_5;
        if (z->c < i_pV) return 0;
        v_5 = z->lb; z->lb = i_pV;
        {
            int v_6 = z->l - z->c;
            do {
                int v_7 = z->l - z->c;
                z->ket = z->c;
                among_var = find_among_b(z, a_0, 9, 0);
                if (!among_var) goto lab6;
                z->bra = z->c;
                switch (among_var) {
                    case 1:
                        do {
                            if (z->c <= z->lb || z->p[z->c - 1] != 0x430) goto lab7;
                            z->c--;
                            break;
                        lab7:
                            if (z->c <= z->lb || z->p[z->c - 1] != 0x44F) goto lab6;
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
                break;
            lab6:
                z->c = z->l - v_7;
                {
                    int v_8 = z->l - z->c;
                    z->ket = z->c;
                    if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 1100 && z->p[z->c - 1] != 1103)) { z->c = z->l - v_8; goto lab8; }
                    if (!find_among_b(z, a_3, 2, 0)) { z->c = z->l - v_8; goto lab8; }
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                lab8:
                    ;
                }
                do {
                    int v_9 = z->l - z->c;
                    z->ket = z->c;
                    if (!find_among_b(z, a_1, 26, 0)) goto lab9;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int v_10 = z->l - z->c;
                        z->ket = z->c;
                        among_var = find_among_b(z, a_2, 8, 0);
                        if (!among_var) { z->c = z->l - v_10; goto lab10; }
                        z->bra = z->c;
                        switch (among_var) {
                            case 1:
                                do {
                                    if (z->c <= z->lb || z->p[z->c - 1] != 0x430) goto lab11;
                                    z->c--;
                                    break;
                                lab11:
                                    if (z->c <= z->lb || z->p[z->c - 1] != 0x44F) { z->c = z->l - v_10; goto lab10; }
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
                    lab10:
                        ;
                    }
                    break;
                lab9:
                    z->c = z->l - v_9;
                    z->ket = z->c;
                    among_var = find_among_b(z, a_4, 46, 0);
                    if (!among_var) goto lab12;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            do {
                                if (z->c <= z->lb || z->p[z->c - 1] != 0x430) goto lab13;
                                z->c--;
                                break;
                            lab13:
                                if (z->c <= z->lb || z->p[z->c - 1] != 0x44F) goto lab12;
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
                    break;
                lab12:
                    z->c = z->l - v_9;
                    z->ket = z->c;
                    if (!find_among_b(z, a_5, 36, 0)) goto lab5;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                } while (0);
            } while (0);
        lab5:
            z->c = z->l - v_6;
        }
        {
            int v_11 = z->l - z->c;
            z->ket = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 0x438) { z->c = z->l - v_11; goto lab14; }
            z->c--;
            z->bra = z->c;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab14:
            ;
        }
        {
            int v_12 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 2 <= z->lb || (z->p[z->c - 1] != 1090 && z->p[z->c - 1] != 1100)) goto lab15;
            if (!find_among_b(z, a_6, 2, 0)) goto lab15;
            z->bra = z->c;
            if (i_p2 > z->c) goto lab15;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab15:
            z->c = z->l - v_12;
        }
        {
            int v_13 = z->l - z->c;
            z->ket = z->c;
            among_var = find_among_b(z, a_7, 4, 0);
            if (!among_var) goto lab16;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    z->ket = z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 0x43D) goto lab16;
                    z->c--;
                    z->bra = z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 0x43D) goto lab16;
                    z->c--;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (z->c <= z->lb || z->p[z->c - 1] != 0x43D) goto lab16;
                    z->c--;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab16:
            z->c = z->l - v_13;
        }
        z->lb = v_5;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * russian_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
