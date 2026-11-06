/*
 * Generated from algorithms/dutch.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "dutch_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

struct SN_local {
    struct SN_env z;
    int i_p2;
    int i_p1;
    symbol * s_ch;
};

typedef struct SN_local SN_local;

#ifdef __cplusplus
extern "C" {
#endif
extern int dutch_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_measure(struct SN_env * z);
static int r_Step_1c(struct SN_env * z);
static int r_lengthen_V(struct SN_env * z);
static int r_V(struct SN_env * z);
static int r_C(struct SN_env * z);

static const symbol s_0[] = { 'i', 'j' };
static const symbol s_1[] = { 'i', 'j' };
static const symbol s_2[] = { 'e', 0xEB, 'e' };
static const symbol s_3[] = { 'i', 'e', 'e' };
static const symbol s_4[] = { 'i', 'n' };
static const symbol s_5[] = { 'n' };
static const symbol s_6[] = { 'e', 'n' };
static const symbol s_7[] = { 'i', 'j' };
static const symbol s_8[] = { 'i', 'j' };
static const symbol s_9[] = { 'i', 'e' };
static const symbol s_10[] = { 'a', 'r' };
static const symbol s_11[] = { 'e', 'r' };
static const symbol s_12[] = { 'e' };
static const symbol s_13[] = { 0xE9 };
static const symbol s_14[] = { 'a', 'u' };
static const symbol s_15[] = { 'h', 'e', 'd' };
static const symbol s_16[] = { 'h', 'e', 'i', 'd' };
static const symbol s_17[] = { 'n', 'd' };
static const symbol s_18[] = { 'n', 'd' };
static const symbol s_19[] = { '\'', 't' };
static const symbol s_20[] = { 'e', 't' };
static const symbol s_21[] = { 'r', 'n', 't' };
static const symbol s_22[] = { 'r', 'n' };
static const symbol s_23[] = { 'i', 'j' };
static const symbol s_24[] = { 'i', 'n', 'k' };
static const symbol s_25[] = { 'i', 'n', 'g' };
static const symbol s_26[] = { 'm', 'p' };
static const symbol s_27[] = { 'm' };
static const symbol s_28[] = { 'g' };
static const symbol s_29[] = { 'l', 'i', 'j', 'k' };
static const symbol s_30[] = { 'i', 's', 'c', 'h' };
static const symbol s_31[] = { 't' };
static const symbol s_32[] = { 's' };
static const symbol s_33[] = { 'r' };
static const symbol s_34[] = { 'l' };
static const symbol s_35[] = { 'e', 'n' };
static const symbol s_36[] = { 'i', 'e', 'f' };
static const symbol s_37[] = { 'e', 'e', 'r' };
static const symbol s_38[] = { 'r' };
static const symbol s_39[] = { 'i', 'l', 'd' };
static const symbol s_40[] = { 'e', 'r' };
static const symbol s_41[] = { 'a', 'a', 'r' };
static const symbol s_42[] = { 'f' };
static const symbol s_43[] = { 'g' };
static const symbol s_44[] = { 't' };
static const symbol s_45[] = { 'd' };
static const symbol s_46[] = { 'i', 'e' };
static const symbol s_47[] = { 'e', 'e', 'r' };
static const symbol s_48[] = { 'n' };
static const symbol s_49[] = { 'l' };
static const symbol s_50[] = { 'r' };
static const symbol s_51[] = { 't', 'e', 'e', 'r' };
static const symbol s_52[] = { 'l', 'i', 'j', 'k' };
static const symbol s_53[] = { 'i', 'n', 'n' };
static const symbol s_54[] = { 'g', 'e' };
static const symbol s_55[] = { 'i', 'j' };
static const symbol s_56[] = { 'i', 'j' };
static const symbol s_57[] = { 'e' };
static const symbol s_58[] = { 'i' };
static const symbol s_59[] = { 'g', 'e' };
static const symbol s_60[] = { 'i', 'j' };
static const symbol s_61[] = { 'i', 'j' };
static const symbol s_62[] = { 'e' };
static const symbol s_63[] = { 'i' };
static const symbol s_64[] = { 'k' };
static const symbol s_65[] = { 'f' };
static const symbol s_66[] = { 'p' };
static const symbol s_67[] = { 'b' };
static const symbol s_68[] = { 'c' };
static const symbol s_69[] = { 'd' };
static const symbol s_70[] = { 'f' };
static const symbol s_71[] = { 'g' };
static const symbol s_72[] = { 'h' };
static const symbol s_73[] = { 'j' };
static const symbol s_74[] = { 'k' };
static const symbol s_75[] = { 'l' };
static const symbol s_76[] = { 'm' };
static const symbol s_77[] = { 'n' };
static const symbol s_78[] = { 'p' };
static const symbol s_79[] = { 'q' };
static const symbol s_80[] = { 'r' };
static const symbol s_81[] = { 's' };
static const symbol s_82[] = { 't' };
static const symbol s_83[] = { 'v' };
static const symbol s_84[] = { 'w' };
static const symbol s_85[] = { 'x' };
static const symbol s_86[] = { 'z' };

static const symbol s_0_0[1] = { 'a' };
static const symbol s_0_1[1] = { 'e' };
static const symbol s_0_2[1] = { 'o' };
static const symbol s_0_3[1] = { 'u' };
static const symbol s_0_4[1] = { 0xE0 };
static const symbol s_0_5[1] = { 0xE1 };
static const symbol s_0_6[1] = { 0xE2 };
static const symbol s_0_7[1] = { 0xE4 };
static const symbol s_0_8[1] = { 0xE8 };
static const symbol s_0_9[1] = { 0xE9 };
static const symbol s_0_10[1] = { 0xEA };
static const symbol s_0_11[2] = { 'e', 0xEB };
static const symbol s_0_12[2] = { 'i', 0xEB };
static const symbol s_0_13[1] = { 0xF2 };
static const symbol s_0_14[1] = { 0xF3 };
static const symbol s_0_15[1] = { 0xF4 };
static const symbol s_0_16[1] = { 0xF6 };
static const symbol s_0_17[1] = { 0xF9 };
static const symbol s_0_18[1] = { 0xFA };
static const symbol s_0_19[1] = { 0xFB };
static const symbol s_0_20[1] = { 0xFC };
static const struct among a_0[21] = {
{ 1, s_0_0, 0, 1, 0},
{ 1, s_0_1, 0, 2, 0},
{ 1, s_0_2, 0, 1, 0},
{ 1, s_0_3, 0, 1, 0},
{ 1, s_0_4, 0, 1, 0},
{ 1, s_0_5, 0, 1, 0},
{ 1, s_0_6, 0, 1, 0},
{ 1, s_0_7, 0, 1, 0},
{ 1, s_0_8, 0, 2, 0},
{ 1, s_0_9, 0, 2, 0},
{ 1, s_0_10, 0, 2, 0},
{ 2, s_0_11, 0, 3, 0},
{ 2, s_0_12, 0, 4, 0},
{ 1, s_0_13, 0, 1, 0},
{ 1, s_0_14, 0, 1, 0},
{ 1, s_0_15, 0, 1, 0},
{ 1, s_0_16, 0, 1, 0},
{ 1, s_0_17, 0, 1, 0},
{ 1, s_0_18, 0, 1, 0},
{ 1, s_0_19, 0, 1, 0},
{ 1, s_0_20, 0, 1, 0}
};

static const symbol s_1_0[3] = { 'n', 'd', 'e' };
static const symbol s_1_1[2] = { 'e', 'n' };
static const symbol s_1_2[1] = { 's' };
static const symbol s_1_3[2] = { '\'', 's' };
static const symbol s_1_4[2] = { 'e', 's' };
static const symbol s_1_5[3] = { 'i', 'e', 's' };
static const symbol s_1_6[3] = { 'a', 'u', 's' };
static const symbol s_1_7[2] = { 0xE9, 's' };
static const struct among a_1[8] = {
{ 3, s_1_0, 0, 8, 0},
{ 2, s_1_1, 0, 7, 0},
{ 1, s_1_2, 0, 2, 0},
{ 2, s_1_3, -1, 1, 0},
{ 2, s_1_4, -2, 4, 0},
{ 3, s_1_5, -1, 3, 0},
{ 3, s_1_6, -4, 6, 0},
{ 2, s_1_7, -5, 5, 0}
};

static const symbol s_2_0[2] = { 'd', 'e' };
static const symbol s_2_1[2] = { 'g', 'e' };
static const symbol s_2_2[5] = { 'i', 's', 'c', 'h', 'e' };
static const symbol s_2_3[2] = { 'j', 'e' };
static const symbol s_2_4[5] = { 'l', 'i', 'j', 'k', 'e' };
static const symbol s_2_5[2] = { 'l', 'e' };
static const symbol s_2_6[3] = { 'e', 'n', 'e' };
static const symbol s_2_7[2] = { 'r', 'e' };
static const symbol s_2_8[2] = { 's', 'e' };
static const symbol s_2_9[2] = { 't', 'e' };
static const symbol s_2_10[4] = { 'i', 'e', 'v', 'e' };
static const struct among a_2[11] = {
{ 2, s_2_0, 0, 5, 0},
{ 2, s_2_1, 0, 2, 0},
{ 5, s_2_2, 0, 4, 0},
{ 2, s_2_3, 0, 1, 0},
{ 5, s_2_4, 0, 3, 0},
{ 2, s_2_5, 0, 9, 0},
{ 3, s_2_6, 0, 10, 0},
{ 2, s_2_7, 0, 8, 0},
{ 2, s_2_8, 0, 7, 0},
{ 2, s_2_9, 0, 6, 0},
{ 4, s_2_10, 0, 11, 0}
};

static const symbol s_3_0[4] = { 'h', 'e', 'i', 'd' };
static const symbol s_3_1[3] = { 'f', 'i', 'e' };
static const symbol s_3_2[3] = { 'g', 'i', 'e' };
static const symbol s_3_3[4] = { 'a', 't', 'i', 'e' };
static const symbol s_3_4[4] = { 'i', 's', 'm', 'e' };
static const symbol s_3_5[3] = { 'i', 'n', 'g' };
static const symbol s_3_6[4] = { 'a', 'r', 'i', 'j' };
static const symbol s_3_7[4] = { 'e', 'r', 'i', 'j' };
static const symbol s_3_8[3] = { 's', 'e', 'l' };
static const symbol s_3_9[4] = { 'r', 'd', 'e', 'r' };
static const symbol s_3_10[4] = { 's', 't', 'e', 'r' };
static const symbol s_3_11[5] = { 'i', 't', 'e', 'i', 't' };
static const symbol s_3_12[3] = { 'd', 's', 't' };
static const symbol s_3_13[3] = { 't', 's', 't' };
static const struct among a_3[14] = {
{ 4, s_3_0, 0, 3, 0},
{ 3, s_3_1, 0, 7, 0},
{ 3, s_3_2, 0, 8, 0},
{ 4, s_3_3, 0, 1, 0},
{ 4, s_3_4, 0, 5, 0},
{ 3, s_3_5, 0, 5, 0},
{ 4, s_3_6, 0, 6, 0},
{ 4, s_3_7, 0, 5, 0},
{ 3, s_3_8, 0, 3, 0},
{ 4, s_3_9, 0, 4, 0},
{ 4, s_3_10, 0, 3, 0},
{ 5, s_3_11, 0, 2, 0},
{ 3, s_3_12, 0, 10, 0},
{ 3, s_3_13, 0, 9, 0}
};

static const symbol s_4_0[3] = { 'e', 'n', 'd' };
static const symbol s_4_1[5] = { 'a', 't', 'i', 'e', 'f' };
static const symbol s_4_2[4] = { 'e', 'r', 'i', 'g' };
static const symbol s_4_3[6] = { 'a', 'c', 'h', 't', 'i', 'g' };
static const symbol s_4_4[6] = { 'i', 'o', 'n', 'e', 'e', 'l' };
static const symbol s_4_5[4] = { 'b', 'a', 'a', 'r' };
static const symbol s_4_6[4] = { 'l', 'a', 'a', 'r' };
static const symbol s_4_7[4] = { 'n', 'a', 'a', 'r' };
static const symbol s_4_8[4] = { 'r', 'a', 'a', 'r' };
static const symbol s_4_9[6] = { 'e', 'r', 'i', 'g', 'e', 'r' };
static const symbol s_4_10[8] = { 'a', 'c', 'h', 't', 'i', 'g', 'e', 'r' };
static const symbol s_4_11[6] = { 'l', 'i', 'j', 'k', 'e', 'r' };
static const symbol s_4_12[4] = { 't', 'a', 'n', 't' };
static const symbol s_4_13[6] = { 'e', 'r', 'i', 'g', 's', 't' };
static const symbol s_4_14[8] = { 'a', 'c', 'h', 't', 'i', 'g', 's', 't' };
static const symbol s_4_15[6] = { 'l', 'i', 'j', 'k', 's', 't' };
static const struct among a_4[16] = {
{ 3, s_4_0, 0, 9, 0},
{ 5, s_4_1, 0, 2, 0},
{ 4, s_4_2, 0, 9, 0},
{ 6, s_4_3, 0, 3, 0},
{ 6, s_4_4, 0, 1, 0},
{ 4, s_4_5, 0, 3, 0},
{ 4, s_4_6, 0, 5, 0},
{ 4, s_4_7, 0, 4, 0},
{ 4, s_4_8, 0, 6, 0},
{ 6, s_4_9, 0, 9, 0},
{ 8, s_4_10, 0, 3, 0},
{ 6, s_4_11, 0, 8, 0},
{ 4, s_4_12, 0, 7, 0},
{ 6, s_4_13, 0, 9, 0},
{ 8, s_4_14, 0, 3, 0},
{ 6, s_4_15, 0, 8, 0}
};

static const symbol s_5_0[2] = { 'i', 'g' };
static const symbol s_5_1[4] = { 'i', 'g', 'e', 'r' };
static const symbol s_5_2[4] = { 'i', 'g', 's', 't' };
static const struct among a_5[3] = {
{ 2, s_5_0, 0, 1, 0},
{ 4, s_5_1, 0, 1, 0},
{ 4, s_5_2, 0, 1, 0}
};

static const symbol s_6_0[2] = { 'f', 't' };
static const symbol s_6_1[2] = { 'k', 't' };
static const symbol s_6_2[2] = { 'p', 't' };
static const struct among a_6[3] = {
{ 2, s_6_0, 0, 2, 0},
{ 2, s_6_1, 0, 1, 0},
{ 2, s_6_2, 0, 3, 0}
};

static const symbol s_7_0[2] = { 'b', 'b' };
static const symbol s_7_1[2] = { 'c', 'c' };
static const symbol s_7_2[2] = { 'd', 'd' };
static const symbol s_7_3[2] = { 'f', 'f' };
static const symbol s_7_4[2] = { 'g', 'g' };
static const symbol s_7_5[2] = { 'h', 'h' };
static const symbol s_7_6[2] = { 'j', 'j' };
static const symbol s_7_7[2] = { 'k', 'k' };
static const symbol s_7_8[2] = { 'l', 'l' };
static const symbol s_7_9[2] = { 'm', 'm' };
static const symbol s_7_10[2] = { 'n', 'n' };
static const symbol s_7_11[2] = { 'p', 'p' };
static const symbol s_7_12[2] = { 'q', 'q' };
static const symbol s_7_13[2] = { 'r', 'r' };
static const symbol s_7_14[2] = { 's', 's' };
static const symbol s_7_15[2] = { 't', 't' };
static const symbol s_7_16[1] = { 'v' };
static const symbol s_7_17[2] = { 'v', 'v' };
static const symbol s_7_18[2] = { 'w', 'w' };
static const symbol s_7_19[2] = { 'x', 'x' };
static const symbol s_7_20[1] = { 'z' };
static const symbol s_7_21[2] = { 'z', 'z' };
static const struct among a_7[22] = {
{ 2, s_7_0, 0, 1, 0},
{ 2, s_7_1, 0, 2, 0},
{ 2, s_7_2, 0, 3, 0},
{ 2, s_7_3, 0, 4, 0},
{ 2, s_7_4, 0, 5, 0},
{ 2, s_7_5, 0, 6, 0},
{ 2, s_7_6, 0, 7, 0},
{ 2, s_7_7, 0, 8, 0},
{ 2, s_7_8, 0, 9, 0},
{ 2, s_7_9, 0, 10, 0},
{ 2, s_7_10, 0, 11, 0},
{ 2, s_7_11, 0, 12, 0},
{ 2, s_7_12, 0, 13, 0},
{ 2, s_7_13, 0, 14, 0},
{ 2, s_7_14, 0, 15, 0},
{ 2, s_7_15, 0, 16, 0},
{ 1, s_7_16, 0, 4, 0},
{ 2, s_7_17, -1, 17, 0},
{ 2, s_7_18, 0, 18, 0},
{ 2, s_7_19, 0, 19, 0},
{ 1, s_7_20, 0, 15, 0},
{ 2, s_7_21, -1, 20, 0}
};

static const symbol s_8_0[1] = { 'd' };
static const symbol s_8_1[1] = { 't' };
static const struct among a_8[2] = {
{ 1, s_8_0, 0, 1, 0},
{ 1, s_8_1, 0, 2, 0}
};

static const symbol s_9_1[3] = { 'e', 'f', 't' };
static const symbol s_9_2[3] = { 'v', 'a', 'a' };
static const symbol s_9_3[3] = { 'v', 'a', 'l' };
static const symbol s_9_4[4] = { 'v', 'a', 'l', 'i' };
static const symbol s_9_5[4] = { 'v', 'a', 'r', 'e' };
static const struct among a_9[6] = {
{ 0, 0, 0, -1, 0},
{ 3, s_9_1, -1, 1, 0},
{ 3, s_9_2, -2, 1, 0},
{ 3, s_9_3, -3, 1, 0},
{ 4, s_9_4, -1, -1, 0},
{ 4, s_9_5, -5, 1, 0}
};

static const symbol s_10_0[1] = { 0xEB };
static const symbol s_10_1[1] = { 0xEF };
static const struct among a_10[2] = {
{ 1, s_10_0, 0, 1, 0},
{ 1, s_10_1, 0, 2, 0}
};

static const symbol s_11_0[1] = { 0xEB };
static const symbol s_11_1[1] = { 0xEF };
static const struct among a_11[2] = {
{ 1, s_11_0, 0, 1, 0},
{ 1, s_11_1, 0, 2, 0}
};

static const unsigned char g_E[] = { 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120 };

static const unsigned char g_AIOU[] = { 1, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 11, 120, 46, 15 };

static const unsigned char g_AEIOU[] = { 17, 65, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 139, 127, 46, 15 };

static const unsigned char g_v[] = { 17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 139, 127, 46, 15 };

static const unsigned char g_v_WX[] = { 17, 65, 208, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 139, 127, 46, 15 };

static int r_V(struct SN_env * z) {
    {
        int v_1 = z->l - z->c;
        do {
            if (in_grouping_b(z, g_v, 97, 252, 0)) goto lab0;
            break;
        lab0:
            if (!(eq_s_b(z, 2, s_0))) return 0;
        } while (0);
        z->c = z->l - v_1;
    }
    return 1;
}

static int r_C(struct SN_env * z) {
    {
        int v_1 = z->l - z->c;
        if (!(eq_s_b(z, 2, s_1))) goto lab0;
        return 0;
    lab0:
        if (out_grouping_b(z, g_v, 97, 252, 0)) return 0;
        z->c = z->l - v_1;
    }
    return 1;
}

static int r_lengthen_V(struct SN_env * z) {
    int among_var;
    {
        int v_1 = z->l - z->c;
        if (out_grouping_b(z, g_v_WX, 97, 252, 0)) goto lab0;
        z->ket = z->c;
        among_var = find_among_b(z, a_0, 21, 0);
        if (!among_var) goto lab0;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int v_2 = z->l - z->c;
                    do {
                        if (out_grouping_b(z, g_AEIOU, 97, 252, 0)) goto lab1;
                        break;
                    lab1:
                        if (z->c > z->lb) goto lab0;
                    } while (0);
                    z->c = z->l - v_2;
                }
                {
                    int ret = slice_to(z, &((SN_local *)z)->s_ch);
                    if (ret < 0) return ret;
                }
                {
                    int saved_c = z->c;
                    int ret = insert_v(z, z->c, z->c, ((SN_local *)z)->s_ch);
                    z->c = saved_c;
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int v_3 = z->l - z->c;
                    do {
                        if (out_grouping_b(z, g_AEIOU, 97, 252, 0)) goto lab2;
                        break;
                    lab2:
                        if (z->c > z->lb) goto lab0;
                    } while (0);
                    {
                        int v_4 = z->l - z->c;
                        do {
                            if (in_grouping_b(z, g_AIOU, 97, 252, 0)) goto lab4;
                            break;
                        lab4:
                            if (in_grouping_b(z, g_E, 101, 235, 0)) goto lab3;
                            if (z->c > z->lb) goto lab3;
                        } while (0);
                        goto lab0;
                    lab3:
                        z->c = z->l - v_4;
                    }
                    {
                        int v_5 = z->l - z->c;
                        if (z->c <= z->lb) goto lab5;
                        z->c--;
                        if (in_grouping_b(z, g_AIOU, 97, 252, 0)) goto lab5;
                        if (out_grouping_b(z, g_AEIOU, 97, 252, 0)) goto lab5;
                        goto lab0;
                    lab5:
                        z->c = z->l - v_5;
                    }
                    z->c = z->l - v_3;
                }
                {
                    int ret = slice_to(z, &((SN_local *)z)->s_ch);
                    if (ret < 0) return ret;
                }
                {
                    int saved_c = z->c;
                    int ret = insert_v(z, z->c, z->c, ((SN_local *)z)->s_ch);
                    z->c = saved_c;
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 3, s_2);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 3, s_3);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab0:
        z->c = z->l - v_1;
    }
    return 1;
}

static int r_Step_1c(struct SN_env * z) {
    int among_var;
    z->ket = z->c;
    if (z->c <= z->lb || (z->p[z->c - 1] != 100 && z->p[z->c - 1] != 116)) return 0;
    among_var = find_among_b(z, a_8, 2, 0);
    if (!among_var) return 0;
    z->bra = z->c;
    if (((SN_local *)z)->i_p1 > z->c) return 0;
    {
        int ret = r_C(z);
        if (ret == 0) return ret;
    }
    switch (among_var) {
        case 1:
            {
                int v_1 = z->l - z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 'n') goto lab0;
                z->c--;
                if (((SN_local *)z)->i_p1 > z->c) goto lab0;
                return 0;
            lab0:
                z->c = z->l - v_1;
            }
            do {
                int v_2 = z->l - z->c;
                if (!(eq_s_b(z, 2, s_4))) goto lab1;
                if (z->c > z->lb) goto lab1;
                {
                    int ret = slice_from_s(z, 1, s_5);
                    if (ret < 0) return ret;
                }
                break;
            lab1:
                z->c = z->l - v_2;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
            } while (0);
            break;
        case 2:
            {
                int v_3 = z->l - z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 'h') goto lab2;
                z->c--;
                if (((SN_local *)z)->i_p1 > z->c) goto lab2;
                return 0;
            lab2:
                z->c = z->l - v_3;
            }
            {
                int v_4 = z->l - z->c;
                if (!(eq_s_b(z, 2, s_6))) goto lab3;
                if (z->c > z->lb) goto lab3;
                return 0;
            lab3:
                z->c = z->l - v_4;
            }
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
    }
    return 1;
}

static int r_measure(struct SN_env * z) {
    ((SN_local *)z)->i_p1 = z->l;
    ((SN_local *)z)->i_p2 = z->l;
    {
        int v_1 = z->c;
        while (1) {
            if (out_grouping(z, g_v, 97, 252, 0)) goto lab1;
            continue;
        lab1:
            break;
        }
        {
            int v_2 = 1;
            while (1) {
                int v_3 = z->c;
                do {
                    if (!(eq_s(z, 2, s_7))) goto lab3;
                    break;
                lab3:
                    if (in_grouping(z, g_v, 97, 252, 0)) goto lab2;
                } while (0);
                v_2--;
                continue;
            lab2:
                z->c = v_3;
                break;
            }
            if (v_2 > 0) goto lab0;
        }
        if (out_grouping(z, g_v, 97, 252, 0)) goto lab0;
        ((SN_local *)z)->i_p1 = z->c;
        while (1) {
            if (out_grouping(z, g_v, 97, 252, 0)) goto lab4;
            continue;
        lab4:
            break;
        }
        {
            int v_4 = 1;
            while (1) {
                int v_5 = z->c;
                do {
                    if (!(eq_s(z, 2, s_8))) goto lab6;
                    break;
                lab6:
                    if (in_grouping(z, g_v, 97, 252, 0)) goto lab5;
                } while (0);
                v_4--;
                continue;
            lab5:
                z->c = v_5;
                break;
            }
            if (v_4 > 0) goto lab0;
        }
        if (out_grouping(z, g_v, 97, 252, 0)) goto lab0;
        ((SN_local *)z)->i_p2 = z->c;
    lab0:
        z->c = v_1;
    }
    return 1;
}

extern int dutch_stem(struct SN_env * z) {
    int among_var;
    int b_GE_removed;
    int b_stemmed;
    b_stemmed = 0;
    {
        int ret = r_measure(z);
        if (ret == 0) return ret;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_1 = z->l - z->c;
        z->ket = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((540704 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab0;
        among_var = find_among_b(z, a_1, 8, 0);
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
                if (((SN_local *)z)->i_p1 > z->c) goto lab0;
                {
                    int v_2 = z->l - z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 't') goto lab1;
                    z->c--;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab1;
                    goto lab0;
                lab1:
                    z->c = z->l - v_2;
                }
                if (!r_C(z)) goto lab0;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                if (((SN_local *)z)->i_p1 > z->c) goto lab0;
                {
                    int ret = slice_from_s(z, 2, s_9);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                do {
                    int v_3 = z->l - z->c;
                    {
                        int v_4 = z->l - z->c;
                        if (!(eq_s_b(z, 2, s_10))) goto lab2;
                        if (((SN_local *)z)->i_p1 > z->c) goto lab2;
                        if (!r_C(z)) goto lab2;
                        z->c = z->l - v_4;
                    }
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_lengthen_V(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab2:
                    z->c = z->l - v_3;
                    {
                        int v_5 = z->l - z->c;
                        if (!(eq_s_b(z, 2, s_11))) goto lab3;
                        if (((SN_local *)z)->i_p1 > z->c) goto lab3;
                        if (!r_C(z)) goto lab3;
                        z->c = z->l - v_5;
                    }
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab3:
                    z->c = z->l - v_3;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab0;
                    if (!r_C(z)) goto lab0;
                    {
                        int ret = slice_from_s(z, 1, s_12);
                        if (ret < 0) return ret;
                    }
                } while (0);
                break;
            case 5:
                if (((SN_local *)z)->i_p1 > z->c) goto lab0;
                {
                    int ret = slice_from_s(z, 1, s_13);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                if (((SN_local *)z)->i_p1 > z->c) goto lab0;
                if (!r_V(z)) goto lab0;
                {
                    int ret = slice_from_s(z, 2, s_14);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                do {
                    int v_6 = z->l - z->c;
                    if (!(eq_s_b(z, 3, s_15))) goto lab4;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab4;
                    z->bra = z->c;
                    {
                        int ret = slice_from_s(z, 4, s_16);
                        if (ret < 0) return ret;
                    }
                    break;
                lab4:
                    z->c = z->l - v_6;
                    if (!(eq_s_b(z, 2, s_17))) goto lab5;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab5:
                    z->c = z->l - v_6;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'd') goto lab6;
                    z->c--;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab6;
                    if (!r_C(z)) goto lab6;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab6:
                    z->c = z->l - v_6;
                    do {
                        if (z->c <= z->lb || z->p[z->c - 1] != 'i') goto lab8;
                        z->c--;
                        break;
                    lab8:
                        if (z->c <= z->lb || z->p[z->c - 1] != 'j') goto lab7;
                        z->c--;
                    } while (0);
                    if (!r_V(z)) goto lab7;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab7:
                    z->c = z->l - v_6;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab0;
                    if (!r_C(z)) goto lab0;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_lengthen_V(z);
                        if (ret < 0) return ret;
                    }
                } while (0);
                break;
            case 8:
                {
                    int ret = slice_from_s(z, 2, s_18);
                    if (ret < 0) return ret;
                }
                break;
        }
        b_stemmed = 1;
    lab0:
        z->c = z->l - v_1;
    }
    {
        int v_7 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] != 101) goto lab9;
        among_var = find_among_b(z, a_2, 11, 0);
        if (!among_var) goto lab9;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                do {
                    int v_8 = z->l - z->c;
                    if (!(eq_s_b(z, 2, s_19))) goto lab10;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab10:
                    z->c = z->l - v_8;
                    if (!(eq_s_b(z, 2, s_20))) goto lab11;
                    z->bra = z->c;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab11;
                    if (!r_C(z)) goto lab11;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab11:
                    z->c = z->l - v_8;
                    if (!(eq_s_b(z, 3, s_21))) goto lab12;
                    z->bra = z->c;
                    {
                        int ret = slice_from_s(z, 2, s_22);
                        if (ret < 0) return ret;
                    }
                    break;
                lab12:
                    z->c = z->l - v_8;
                    if (z->c <= z->lb || z->p[z->c - 1] != 't') goto lab13;
                    z->c--;
                    z->bra = z->c;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab13;
                    {
                        int v_9 = z->l - z->c;
                        if (z->c <= z->lb) goto lab13;
                        z->c--;
                        do {
                            if (in_grouping_b(z, g_v, 97, 252, 0)) goto lab14;
                            break;
                        lab14:
                            if (!(eq_s_b(z, 2, s_23))) goto lab13;
                        } while (0);
                        z->c = z->l - v_9;
                    }
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab13:
                    z->c = z->l - v_8;
                    if (!(eq_s_b(z, 3, s_24))) goto lab15;
                    z->bra = z->c;
                    {
                        int ret = slice_from_s(z, 3, s_25);
                        if (ret < 0) return ret;
                    }
                    break;
                lab15:
                    z->c = z->l - v_8;
                    if (!(eq_s_b(z, 2, s_26))) goto lab16;
                    z->bra = z->c;
                    {
                        int ret = slice_from_s(z, 1, s_27);
                        if (ret < 0) return ret;
                    }
                    break;
                lab16:
                    z->c = z->l - v_8;
                    if (z->c <= z->lb || z->p[z->c - 1] != '\'') goto lab17;
                    z->c--;
                    z->bra = z->c;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab17;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab17:
                    z->c = z->l - v_8;
                    z->bra = z->c;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                    if (!r_C(z)) goto lab9;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                } while (0);
                break;
            case 2:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                {
                    int ret = slice_from_s(z, 1, s_28);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                {
                    int ret = slice_from_s(z, 4, s_29);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                {
                    int ret = slice_from_s(z, 4, s_30);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                if (!r_C(z)) goto lab9;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                {
                    int ret = slice_from_s(z, 1, s_31);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                {
                    int ret = slice_from_s(z, 1, s_32);
                    if (ret < 0) return ret;
                }
                break;
            case 8:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                {
                    int ret = slice_from_s(z, 1, s_33);
                    if (ret < 0) return ret;
                }
                break;
            case 9:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int ret = insert_s(z, z->c, z->c, 1, s_34);
                    if (ret < 0) return ret;
                }
                {
                    int ret = r_lengthen_V(z);
                    if (ret < 0) return ret;
                }
                break;
            case 10:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                if (!r_C(z)) goto lab9;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int ret = insert_s(z, z->c, z->c, 2, s_35);
                    if (ret < 0) return ret;
                }
                {
                    int ret = r_lengthen_V(z);
                    if (ret < 0) return ret;
                }
                break;
            case 11:
                if (((SN_local *)z)->i_p1 > z->c) goto lab9;
                if (!r_C(z)) goto lab9;
                {
                    int ret = slice_from_s(z, 3, s_36);
                    if (ret < 0) return ret;
                }
                break;
        }
        b_stemmed = 1;
    lab9:
        z->c = z->l - v_7;
    }
    {
        int v_10 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 2 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1316016 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab18;
        among_var = find_among_b(z, a_3, 14, 0);
        if (!among_var) goto lab18;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                if (((SN_local *)z)->i_p1 > z->c) goto lab18;
                {
                    int ret = slice_from_s(z, 3, s_37);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                if (((SN_local *)z)->i_p1 > z->c) goto lab18;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int ret = r_lengthen_V(z);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                if (((SN_local *)z)->i_p1 > z->c) goto lab18;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 1, s_38);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                do {
                    int v_11 = z->l - z->c;
                    if (!(eq_s_b(z, 3, s_39))) goto lab19;
                    {
                        int ret = slice_from_s(z, 2, s_40);
                        if (ret < 0) return ret;
                    }
                    break;
                lab19:
                    z->c = z->l - v_11;
                    if (((SN_local *)z)->i_p1 > z->c) goto lab18;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_lengthen_V(z);
                        if (ret < 0) return ret;
                    }
                } while (0);
                break;
            case 6:
                if (((SN_local *)z)->i_p1 > z->c) goto lab18;
                if (!r_C(z)) goto lab18;
                {
                    int ret = slice_from_s(z, 3, s_41);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                if (((SN_local *)z)->i_p2 > z->c) goto lab18;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int ret = insert_s(z, z->c, z->c, 1, s_42);
                    if (ret < 0) return ret;
                }
                {
                    int ret = r_lengthen_V(z);
                    if (ret < 0) return ret;
                }
                break;
            case 8:
                if (((SN_local *)z)->i_p2 > z->c) goto lab18;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                {
                    int ret = insert_s(z, z->c, z->c, 1, s_43);
                    if (ret < 0) return ret;
                }
                {
                    int ret = r_lengthen_V(z);
                    if (ret < 0) return ret;
                }
                break;
            case 9:
                if (((SN_local *)z)->i_p1 > z->c) goto lab18;
                if (!r_C(z)) goto lab18;
                {
                    int ret = slice_from_s(z, 1, s_44);
                    if (ret < 0) return ret;
                }
                break;
            case 10:
                if (((SN_local *)z)->i_p1 > z->c) goto lab18;
                if (!r_C(z)) goto lab18;
                {
                    int ret = slice_from_s(z, 1, s_45);
                    if (ret < 0) return ret;
                }
                break;
        }
        b_stemmed = 1;
    lab18:
        z->c = z->l - v_10;
    }
    {
        int v_12 = z->l - z->c;
        do {
            int v_13 = z->l - z->c;
            z->ket = z->c;
            if (z->c - 2 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1315024 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab21;
            among_var = find_among_b(z, a_4, 16, 0);
            if (!among_var) goto lab21;
            z->bra = z->c;
            switch (among_var) {
                case 1:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    {
                        int ret = slice_from_s(z, 2, s_46);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    {
                        int ret = slice_from_s(z, 3, s_47);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    if (!r_V(z)) goto lab21;
                    {
                        int ret = slice_from_s(z, 1, s_48);
                        if (ret < 0) return ret;
                    }
                    break;
                case 5:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    if (!r_V(z)) goto lab21;
                    {
                        int ret = slice_from_s(z, 1, s_49);
                        if (ret < 0) return ret;
                    }
                    break;
                case 6:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    if (!r_V(z)) goto lab21;
                    {
                        int ret = slice_from_s(z, 1, s_50);
                        if (ret < 0) return ret;
                    }
                    break;
                case 7:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    {
                        int ret = slice_from_s(z, 4, s_51);
                        if (ret < 0) return ret;
                    }
                    break;
                case 8:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    {
                        int ret = slice_from_s(z, 4, s_52);
                        if (ret < 0) return ret;
                    }
                    break;
                case 9:
                    if (((SN_local *)z)->i_p1 > z->c) goto lab21;
                    if (!r_C(z)) goto lab21;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    {
                        int ret = r_lengthen_V(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
            break;
        lab21:
            z->c = z->l - v_13;
            z->ket = z->c;
            if (z->c - 1 <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((1310848 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab20;
            if (!find_among_b(z, a_5, 3, 0)) goto lab20;
            z->bra = z->c;
            if (((SN_local *)z)->i_p1 > z->c) goto lab20;
            {
                int v_14 = z->l - z->c;
                if (!(eq_s_b(z, 3, s_53))) goto lab22;
                if (z->c > z->lb) goto lab22;
                goto lab20;
            lab22:
                z->c = z->l - v_14;
            }
            if (!r_C(z)) goto lab20;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int ret = r_lengthen_V(z);
                if (ret < 0) return ret;
            }
        } while (0);
        b_stemmed = 1;
    lab20:
        z->c = z->l - v_12;
    }
    z->c = z->lb;
    b_GE_removed = 0;
    {
        int v_15 = z->c;
        {
            int v_16 = z->c;
            z->bra = z->c;
            if (!(eq_s(z, 2, s_54))) goto lab23;
            z->ket = z->c;
            {
                int v_17 = z->c;
                if (z->c + 3 > z->l) goto lab23;
                z->c += 3;
                z->c = v_17;
            }
            {
                int v_18 = z->c;
                while (1) {
                    int v_19 = z->c;
                    do {
                        if (!(eq_s(z, 2, s_55))) goto lab25;
                        break;
                    lab25:
                        if (in_grouping(z, g_v, 97, 252, 0)) goto lab24;
                    } while (0);
                    break;
                lab24:
                    z->c = v_19;
                    if (z->c >= z->l) goto lab23;
                    z->c++;
                }
                while (1) {
                    int v_20 = z->c;
                    do {
                        if (!(eq_s(z, 2, s_56))) goto lab27;
                        break;
                    lab27:
                        if (in_grouping(z, g_v, 97, 252, 0)) goto lab26;
                    } while (0);
                    continue;
                lab26:
                    z->c = v_20;
                    break;
                }
                if (z->c >= z->l) goto lab23;
                z->c = v_18;
            }
            if (z->c + 2 >= z->l || z->p[z->c + 2] >> 5 != 3 || !((1314818 >> (z->p[z->c + 2] & 0x1f)) & 1)) among_var = -1; else
            among_var = find_among(z, a_9, 6, 0);
            switch (among_var) {
                case 1:
                    goto lab23;
                    break;
            }
            b_GE_removed = 1;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_21 = z->c;
                z->bra = z->c;
                if (z->c >= z->l || (z->p[z->c + 0] != 235 && z->p[z->c + 0] != 239)) goto lab28;
                among_var = find_among(z, a_10, 2, 0);
                if (!among_var) goto lab28;
                z->ket = z->c;
                switch (among_var) {
                    case 1:
                        {
                            int ret = slice_from_s(z, 1, s_57);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 2:
                        {
                            int ret = slice_from_s(z, 1, s_58);
                            if (ret < 0) return ret;
                        }
                        break;
                }
            lab28:
                z->c = v_21;
            }
            z->c = v_16;
            r_measure(z);
        }
    lab23:
        z->c = v_15;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_22 = z->l - z->c;
        if (!b_GE_removed) goto lab29;
        b_stemmed = 1;
        {
            int ret = r_Step_1c(z);
            if (ret == 0) goto lab29;
            if (ret < 0) return ret;
        }
    lab29:
        z->c = z->l - v_22;
    }
    z->c = z->lb;
    b_GE_removed = 0;
    {
        int v_23 = z->c;
        {
            int v_24 = z->c;
            if (z->c >= z->l) goto lab30;
            z->c++;
            while (1) {
                z->bra = z->c;
                if (!(eq_s(z, 2, s_59))) goto lab31;
                z->ket = z->c;
                break;
            lab31:
                if (z->c >= z->l) goto lab30;
                z->c++;
            }
            {
                int v_25 = z->c;
                if (z->c + 3 > z->l) goto lab30;
                z->c += 3;
                z->c = v_25;
            }
            {
                int v_26 = z->c;
                while (1) {
                    int v_27 = z->c;
                    do {
                        if (!(eq_s(z, 2, s_60))) goto lab33;
                        break;
                    lab33:
                        if (in_grouping(z, g_v, 97, 252, 0)) goto lab32;
                    } while (0);
                    break;
                lab32:
                    z->c = v_27;
                    if (z->c >= z->l) goto lab30;
                    z->c++;
                }
                while (1) {
                    int v_28 = z->c;
                    do {
                        if (!(eq_s(z, 2, s_61))) goto lab35;
                        break;
                    lab35:
                        if (in_grouping(z, g_v, 97, 252, 0)) goto lab34;
                    } while (0);
                    continue;
                lab34:
                    z->c = v_28;
                    break;
                }
                if (z->c >= z->l) goto lab30;
                z->c = v_26;
            }
            b_GE_removed = 1;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            {
                int v_29 = z->c;
                z->bra = z->c;
                if (z->c >= z->l || (z->p[z->c + 0] != 235 && z->p[z->c + 0] != 239)) goto lab36;
                among_var = find_among(z, a_11, 2, 0);
                if (!among_var) goto lab36;
                z->ket = z->c;
                switch (among_var) {
                    case 1:
                        {
                            int ret = slice_from_s(z, 1, s_62);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 2:
                        {
                            int ret = slice_from_s(z, 1, s_63);
                            if (ret < 0) return ret;
                        }
                        break;
                }
            lab36:
                z->c = v_29;
            }
            z->c = v_24;
            r_measure(z);
        }
    lab30:
        z->c = v_23;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_30 = z->l - z->c;
        if (!b_GE_removed) goto lab37;
        b_stemmed = 1;
        {
            int ret = r_Step_1c(z);
            if (ret == 0) goto lab37;
            if (ret < 0) return ret;
        }
    lab37:
        z->c = z->l - v_30;
    }
    z->c = z->lb;
    z->lb = z->c; z->c = z->l;
    {
        int v_31 = z->l - z->c;
        z->ket = z->c;
        if (z->c - 1 <= z->lb || z->p[z->c - 1] != 116) goto lab38;
        among_var = find_among_b(z, a_6, 3, 0);
        if (!among_var) goto lab38;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_64);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_65);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_66);
                    if (ret < 0) return ret;
                }
                break;
        }
        b_stemmed = 1;
    lab38:
        z->c = z->l - v_31;
    }
    {
        int v_32 = z->l - z->c;
        if (!b_stemmed) goto lab39;
        z->ket = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 3 || !((98532828 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab39;
        among_var = find_among_b(z, a_7, 22, 0);
        if (!among_var) goto lab39;
        z->bra = z->c;
        switch (among_var) {
            case 1:
                {
                    int ret = slice_from_s(z, 1, s_67);
                    if (ret < 0) return ret;
                }
                break;
            case 2:
                {
                    int ret = slice_from_s(z, 1, s_68);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_from_s(z, 1, s_69);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                {
                    int ret = slice_from_s(z, 1, s_70);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                {
                    int ret = slice_from_s(z, 1, s_71);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                {
                    int ret = slice_from_s(z, 1, s_72);
                    if (ret < 0) return ret;
                }
                break;
            case 7:
                {
                    int ret = slice_from_s(z, 1, s_73);
                    if (ret < 0) return ret;
                }
                break;
            case 8:
                {
                    int ret = slice_from_s(z, 1, s_74);
                    if (ret < 0) return ret;
                }
                break;
            case 9:
                {
                    int ret = slice_from_s(z, 1, s_75);
                    if (ret < 0) return ret;
                }
                break;
            case 10:
                {
                    int ret = slice_from_s(z, 1, s_76);
                    if (ret < 0) return ret;
                }
                break;
            case 11:
                {
                    int v_33 = z->l - z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 'i') goto lab40;
                    z->c--;
                    if (z->c > z->lb) goto lab40;
                    goto lab39;
                lab40:
                    z->c = z->l - v_33;
                }
                {
                    int ret = slice_from_s(z, 1, s_77);
                    if (ret < 0) return ret;
                }
                break;
            case 12:
                {
                    int ret = slice_from_s(z, 1, s_78);
                    if (ret < 0) return ret;
                }
                break;
            case 13:
                {
                    int ret = slice_from_s(z, 1, s_79);
                    if (ret < 0) return ret;
                }
                break;
            case 14:
                {
                    int ret = slice_from_s(z, 1, s_80);
                    if (ret < 0) return ret;
                }
                break;
            case 15:
                {
                    int ret = slice_from_s(z, 1, s_81);
                    if (ret < 0) return ret;
                }
                break;
            case 16:
                {
                    int ret = slice_from_s(z, 1, s_82);
                    if (ret < 0) return ret;
                }
                break;
            case 17:
                {
                    int ret = slice_from_s(z, 1, s_83);
                    if (ret < 0) return ret;
                }
                break;
            case 18:
                {
                    int ret = slice_from_s(z, 1, s_84);
                    if (ret < 0) return ret;
                }
                break;
            case 19:
                {
                    int ret = slice_from_s(z, 1, s_85);
                    if (ret < 0) return ret;
                }
                break;
            case 20:
                {
                    int ret = slice_from_s(z, 1, s_86);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab39:
        z->c = z->l - v_32;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * dutch_create_env(void) {
    struct SN_env * z = SN_new_env(sizeof(SN_local));
    if (z) {
        if ((((SN_local *)z)->s_ch = create_s()) == NULL) {
            dutch_close_env(z);
            return NULL;
        }
    }
    return z;
}

extern void dutch_close_env(struct SN_env * z) {
    if (!z) return;
    lose_s(((SN_local *)z)->s_ch);
    SN_delete_env(z);
}

