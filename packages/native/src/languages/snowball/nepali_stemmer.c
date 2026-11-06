/*
 * Generated from algorithms/nepali.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "nepali_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int nepali_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static const symbol s_0[] = { 0x92F, 0x94C };
static const symbol s_1[] = { 0x91B, 0x94C };
static const symbol s_2[] = { 0x928, 0x94C };
static const symbol s_3[] = { 0x925, 0x947 };
static const symbol s_4[] = { 0x924, 0x94D, 0x930 };

static const symbol s_0_0[3] = { 0x932, 0x93E, 0x907 };
static const symbol s_0_1[3] = { 0x932, 0x93E, 0x908 };
static const symbol s_0_2[3] = { 0x938, 0x901, 0x917 };
static const symbol s_0_3[3] = { 0x938, 0x902, 0x917 };
static const symbol s_0_4[6] = { 0x92E, 0x93E, 0x930, 0x94D, 0x92B, 0x924 };
static const symbol s_0_5[2] = { 0x930, 0x924 };
static const symbol s_0_6[2] = { 0x915, 0x93E };
static const symbol s_0_7[2] = { 0x92E, 0x93E };
static const symbol s_0_8[6] = { 0x926, 0x94D, 0x935, 0x93E, 0x930, 0x93E };
static const symbol s_0_9[2] = { 0x915, 0x93F };
static const symbol s_0_10[3] = { 0x92A, 0x91B, 0x93F };
static const symbol s_0_11[2] = { 0x915, 0x940 };
static const symbol s_0_12[2] = { 0x932, 0x947 };
static const symbol s_0_13[2] = { 0x915, 0x948 };
static const symbol s_0_14[4] = { 0x938, 0x901, 0x917, 0x948 };
static const symbol s_0_15[2] = { 0x92E, 0x948 };
static const symbol s_0_16[2] = { 0x915, 0x94B };
static const struct among a_0[17] = {
{ 3, s_0_0, 0, 1, 0},
{ 3, s_0_1, 0, 1, 0},
{ 3, s_0_2, 0, 1, 0},
{ 3, s_0_3, 0, 1, 0},
{ 6, s_0_4, 0, 1, 0},
{ 2, s_0_5, 0, 1, 0},
{ 2, s_0_6, 0, 2, 0},
{ 2, s_0_7, 0, 1, 0},
{ 6, s_0_8, 0, 1, 0},
{ 2, s_0_9, 0, 2, 0},
{ 3, s_0_10, 0, 1, 0},
{ 2, s_0_11, 0, 2, 0},
{ 2, s_0_12, 0, 1, 0},
{ 2, s_0_13, 0, 2, 0},
{ 4, s_0_14, 0, 1, 0},
{ 2, s_0_15, 0, 1, 0},
{ 2, s_0_16, 0, 2, 0}
};

static const symbol s_1_0[1] = { 0x901 };
static const symbol s_1_1[1] = { 0x902 };
static const symbol s_1_2[1] = { 0x948 };
static const struct among a_1[3] = {
{ 1, s_1_0, 0, 1, 0},
{ 1, s_1_1, 0, 1, 0},
{ 1, s_1_2, 0, 2, 0}
};

static const symbol s_2_0[3] = { 0x925, 0x93F, 0x90F };
static const symbol s_2_1[1] = { 0x91B };
static const symbol s_2_2[2] = { 0x907, 0x91B };
static const symbol s_2_3[2] = { 0x90F, 0x91B };
static const symbol s_2_4[2] = { 0x93F, 0x91B };
static const symbol s_2_5[2] = { 0x947, 0x91B };
static const symbol s_2_6[3] = { 0x928, 0x947, 0x91B };
static const symbol s_2_7[5] = { 0x939, 0x941, 0x928, 0x947, 0x91B };
static const symbol s_2_8[4] = { 0x907, 0x928, 0x94D, 0x91B };
static const symbol s_2_9[4] = { 0x93F, 0x928, 0x94D, 0x91B };
static const symbol s_2_10[5] = { 0x939, 0x941, 0x928, 0x94D, 0x91B };
static const symbol s_2_11[3] = { 0x90F, 0x915, 0x93E };
static const symbol s_2_12[4] = { 0x907, 0x90F, 0x915, 0x93E };
static const symbol s_2_13[4] = { 0x93F, 0x90F, 0x915, 0x93E };
static const symbol s_2_14[3] = { 0x947, 0x915, 0x93E };
static const symbol s_2_15[4] = { 0x928, 0x947, 0x915, 0x93E };
static const symbol s_2_16[2] = { 0x926, 0x93E };
static const symbol s_2_17[3] = { 0x907, 0x926, 0x93E };
static const symbol s_2_18[3] = { 0x93F, 0x926, 0x93E };
static const symbol s_2_19[4] = { 0x926, 0x947, 0x916, 0x93F };
static const symbol s_2_20[4] = { 0x92E, 0x93E, 0x925, 0x93F };
static const symbol s_2_21[3] = { 0x90F, 0x915, 0x940 };
static const symbol s_2_22[4] = { 0x907, 0x90F, 0x915, 0x940 };
static const symbol s_2_23[4] = { 0x93F, 0x90F, 0x915, 0x940 };
static const symbol s_2_24[3] = { 0x947, 0x915, 0x940 };
static const symbol s_2_25[4] = { 0x926, 0x947, 0x916, 0x940 };
static const symbol s_2_26[2] = { 0x925, 0x940 };
static const symbol s_2_27[2] = { 0x926, 0x940 };
static const symbol s_2_28[2] = { 0x91B, 0x941 };
static const symbol s_2_29[3] = { 0x90F, 0x91B, 0x941 };
static const symbol s_2_30[3] = { 0x947, 0x91B, 0x941 };
static const symbol s_2_31[4] = { 0x928, 0x947, 0x91B, 0x941 };
static const symbol s_2_32[2] = { 0x928, 0x941 };
static const symbol s_2_33[3] = { 0x939, 0x930, 0x941 };
static const symbol s_2_34[3] = { 0x939, 0x930, 0x942 };
static const symbol s_2_35[2] = { 0x91B, 0x947 };
static const symbol s_2_36[2] = { 0x925, 0x947 };
static const symbol s_2_37[2] = { 0x928, 0x947 };
static const symbol s_2_38[3] = { 0x90F, 0x915, 0x948 };
static const symbol s_2_39[3] = { 0x947, 0x915, 0x948 };
static const symbol s_2_40[4] = { 0x928, 0x947, 0x915, 0x948 };
static const symbol s_2_41[2] = { 0x926, 0x948 };
static const symbol s_2_42[3] = { 0x907, 0x926, 0x948 };
static const symbol s_2_43[3] = { 0x93F, 0x926, 0x948 };
static const symbol s_2_44[3] = { 0x90F, 0x915, 0x94B };
static const symbol s_2_45[4] = { 0x907, 0x90F, 0x915, 0x94B };
static const symbol s_2_46[4] = { 0x93F, 0x90F, 0x915, 0x94B };
static const symbol s_2_47[3] = { 0x947, 0x915, 0x94B };
static const symbol s_2_48[4] = { 0x928, 0x947, 0x915, 0x94B };
static const symbol s_2_49[2] = { 0x926, 0x94B };
static const symbol s_2_50[3] = { 0x907, 0x926, 0x94B };
static const symbol s_2_51[3] = { 0x93F, 0x926, 0x94B };
static const symbol s_2_52[2] = { 0x92F, 0x94B };
static const symbol s_2_53[3] = { 0x907, 0x92F, 0x94B };
static const symbol s_2_54[3] = { 0x92D, 0x92F, 0x94B };
static const symbol s_2_55[3] = { 0x93F, 0x92F, 0x94B };
static const symbol s_2_56[4] = { 0x925, 0x93F, 0x92F, 0x94B };
static const symbol s_2_57[4] = { 0x926, 0x93F, 0x92F, 0x94B };
static const symbol s_2_58[4] = { 0x925, 0x94D, 0x92F, 0x94B };
static const symbol s_2_59[2] = { 0x91B, 0x94C };
static const symbol s_2_60[3] = { 0x907, 0x91B, 0x94C };
static const symbol s_2_61[3] = { 0x90F, 0x91B, 0x94C };
static const symbol s_2_62[3] = { 0x93F, 0x91B, 0x94C };
static const symbol s_2_63[3] = { 0x947, 0x91B, 0x94C };
static const symbol s_2_64[4] = { 0x928, 0x947, 0x91B, 0x94C };
static const symbol s_2_65[2] = { 0x92F, 0x94C };
static const symbol s_2_66[4] = { 0x925, 0x93F, 0x92F, 0x94C };
static const symbol s_2_67[4] = { 0x91B, 0x94D, 0x92F, 0x94C };
static const symbol s_2_68[4] = { 0x925, 0x94D, 0x92F, 0x94C };
static const symbol s_2_69[3] = { 0x91B, 0x928, 0x94D };
static const symbol s_2_70[4] = { 0x907, 0x91B, 0x928, 0x94D };
static const symbol s_2_71[4] = { 0x90F, 0x91B, 0x928, 0x94D };
static const symbol s_2_72[4] = { 0x93F, 0x91B, 0x928, 0x94D };
static const symbol s_2_73[4] = { 0x947, 0x91B, 0x928, 0x94D };
static const symbol s_2_74[5] = { 0x928, 0x947, 0x91B, 0x928, 0x94D };
static const symbol s_2_75[4] = { 0x932, 0x93E, 0x928, 0x94D };
static const symbol s_2_76[4] = { 0x91B, 0x93F, 0x928, 0x94D };
static const symbol s_2_77[4] = { 0x925, 0x93F, 0x928, 0x94D };
static const symbol s_2_78[3] = { 0x92A, 0x930, 0x94D };
static const symbol s_2_79[3] = { 0x907, 0x938, 0x94D };
static const symbol s_2_80[5] = { 0x925, 0x93F, 0x907, 0x938, 0x94D };
static const symbol s_2_81[3] = { 0x91B, 0x938, 0x94D };
static const symbol s_2_82[4] = { 0x907, 0x91B, 0x938, 0x94D };
static const symbol s_2_83[4] = { 0x90F, 0x91B, 0x938, 0x94D };
static const symbol s_2_84[4] = { 0x93F, 0x91B, 0x938, 0x94D };
static const symbol s_2_85[4] = { 0x947, 0x91B, 0x938, 0x94D };
static const symbol s_2_86[5] = { 0x928, 0x947, 0x91B, 0x938, 0x94D };
static const symbol s_2_87[3] = { 0x93F, 0x938, 0x94D };
static const symbol s_2_88[4] = { 0x925, 0x93F, 0x938, 0x94D };
static const symbol s_2_89[4] = { 0x91B, 0x947, 0x938, 0x94D };
static const symbol s_2_90[4] = { 0x939, 0x94B, 0x938, 0x94D };
static const struct among a_2[91] = {
{ 3, s_2_0, 0, 1, 0},
{ 1, s_2_1, 0, 1, 0},
{ 2, s_2_2, -1, 1, 0},
{ 2, s_2_3, -2, 1, 0},
{ 2, s_2_4, -3, 1, 0},
{ 2, s_2_5, -4, 1, 0},
{ 3, s_2_6, -1, 1, 0},
{ 5, s_2_7, -1, 1, 0},
{ 4, s_2_8, -7, 1, 0},
{ 4, s_2_9, -8, 1, 0},
{ 5, s_2_10, -9, 1, 0},
{ 3, s_2_11, 0, 1, 0},
{ 4, s_2_12, -1, 1, 0},
{ 4, s_2_13, -2, 1, 0},
{ 3, s_2_14, 0, 1, 0},
{ 4, s_2_15, -1, 1, 0},
{ 2, s_2_16, 0, 1, 0},
{ 3, s_2_17, -1, 1, 0},
{ 3, s_2_18, -2, 1, 0},
{ 4, s_2_19, 0, 1, 0},
{ 4, s_2_20, 0, 1, 0},
{ 3, s_2_21, 0, 1, 0},
{ 4, s_2_22, -1, 1, 0},
{ 4, s_2_23, -2, 1, 0},
{ 3, s_2_24, 0, 1, 0},
{ 4, s_2_25, 0, 1, 0},
{ 2, s_2_26, 0, 1, 0},
{ 2, s_2_27, 0, 1, 0},
{ 2, s_2_28, 0, 1, 0},
{ 3, s_2_29, -1, 1, 0},
{ 3, s_2_30, -2, 1, 0},
{ 4, s_2_31, -1, 1, 0},
{ 2, s_2_32, 0, 1, 0},
{ 3, s_2_33, 0, 1, 0},
{ 3, s_2_34, 0, 1, 0},
{ 2, s_2_35, 0, 1, 0},
{ 2, s_2_36, 0, 1, 0},
{ 2, s_2_37, 0, 1, 0},
{ 3, s_2_38, 0, 1, 0},
{ 3, s_2_39, 0, 1, 0},
{ 4, s_2_40, -1, 1, 0},
{ 2, s_2_41, 0, 1, 0},
{ 3, s_2_42, -1, 1, 0},
{ 3, s_2_43, -2, 1, 0},
{ 3, s_2_44, 0, 1, 0},
{ 4, s_2_45, -1, 1, 0},
{ 4, s_2_46, -2, 1, 0},
{ 3, s_2_47, 0, 1, 0},
{ 4, s_2_48, -1, 1, 0},
{ 2, s_2_49, 0, 1, 0},
{ 3, s_2_50, -1, 1, 0},
{ 3, s_2_51, -2, 1, 0},
{ 2, s_2_52, 0, 1, 0},
{ 3, s_2_53, -1, 1, 0},
{ 3, s_2_54, -2, 1, 0},
{ 3, s_2_55, -3, 1, 0},
{ 4, s_2_56, -1, 1, 0},
{ 4, s_2_57, -2, 1, 0},
{ 4, s_2_58, -6, 1, 0},
{ 2, s_2_59, 0, 1, 0},
{ 3, s_2_60, -1, 1, 0},
{ 3, s_2_61, -2, 1, 0},
{ 3, s_2_62, -3, 1, 0},
{ 3, s_2_63, -4, 1, 0},
{ 4, s_2_64, -1, 1, 0},
{ 2, s_2_65, 0, 1, 0},
{ 4, s_2_66, -1, 1, 0},
{ 4, s_2_67, -2, 1, 0},
{ 4, s_2_68, -3, 1, 0},
{ 3, s_2_69, 0, 1, 0},
{ 4, s_2_70, -1, 1, 0},
{ 4, s_2_71, -2, 1, 0},
{ 4, s_2_72, -3, 1, 0},
{ 4, s_2_73, -4, 1, 0},
{ 5, s_2_74, -1, 1, 0},
{ 4, s_2_75, 0, 1, 0},
{ 4, s_2_76, 0, 1, 0},
{ 4, s_2_77, 0, 1, 0},
{ 3, s_2_78, 0, 1, 0},
{ 3, s_2_79, 0, 1, 0},
{ 5, s_2_80, -1, 1, 0},
{ 3, s_2_81, 0, 1, 0},
{ 4, s_2_82, -1, 1, 0},
{ 4, s_2_83, -2, 1, 0},
{ 4, s_2_84, -3, 1, 0},
{ 4, s_2_85, -4, 1, 0},
{ 5, s_2_86, -1, 1, 0},
{ 3, s_2_87, 0, 1, 0},
{ 4, s_2_88, -1, 1, 0},
{ 4, s_2_89, 0, 1, 0},
{ 4, s_2_90, 0, 1, 0}
};

extern int nepali_stem(struct SN_env * z) {
    int among_var;
    z->lb = z->c; z->c = z->l;
    {
        int v_1 = z->l - z->c;
        z->ket = z->c;
        among_var = find_among_b(z, a_0, 17, 0);
        if (!among_var) goto lab0;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                do {
                    if (z->c <= z->lb || z->p[z->c - 1] != 0x90F) goto lab1;
                    z->c--;
                    break;
                lab1:
                    if (z->c <= z->lb || z->p[z->c - 1] != 0x947) goto lab2;
                    z->c--;
                    break;
                lab2:
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                } while (0);
                break;
        }
    lab0:
        z->c = z->l - v_1;
    }
    while (1) {
        int v_2 = z->l - z->c;
        {
            int v_3 = z->l - z->c;
            z->ket = z->c;
            among_var = find_among_b(z, a_1, 3, 0);
            if (!among_var) goto lab4;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    do {
                        if (!(eq_s_b(z, 2, s_0))) goto lab5;
                        break;
                    lab5:
                        if (!(eq_s_b(z, 2, s_1))) goto lab6;
                        break;
                    lab6:
                        if (!(eq_s_b(z, 2, s_2))) goto lab7;
                        break;
                    lab7:
                        if (!(eq_s_b(z, 2, s_3))) goto lab4;
                    } while (0);
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (!(eq_s_b(z, 3, s_4))) goto lab4;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab4:
            z->c = z->l - v_3;
        }
        z->ket = z->c;
        if (!find_among_b(z, a_2, 91, 0)) goto lab3;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        continue;
    lab3:
        z->c = z->l - v_2;
        break;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * nepali_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
