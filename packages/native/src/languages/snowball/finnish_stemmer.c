/*
 * Generated from algorithms/finnish.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "finnish_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

struct SN_local {
    struct SN_env z;
    symbol * s_x;
};

typedef struct SN_local SN_local;

#ifdef __cplusplus
extern "C" {
#endif
extern int finnish_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_O_(struct SN_env * z);
static int r_A_(struct SN_env * z);
static int r_U(struct SN_env * z);
static int r_O(struct SN_env * z);
static int r_I(struct SN_env * z);
static int r_E(struct SN_env * z);
static int r_A(struct SN_env * z);
static int r_VI(struct SN_env * z);
static int r_LV(struct SN_env * z);

static const symbol s_0[] = { 'k', 's', 'e' };
static const symbol s_1[] = { 'k', 's', 'i' };
static const symbol s_2[] = { 'i', 'e' };
static const symbol s_3[] = { 'p', 'o' };
static const symbol s_4[] = { 'p', 'o' };

static const symbol s_0_0[2] = { 'p', 'a' };
static const symbol s_0_1[3] = { 's', 't', 'i' };
static const symbol s_0_2[4] = { 'k', 'a', 'a', 'n' };
static const symbol s_0_3[3] = { 'h', 'a', 'n' };
static const symbol s_0_4[3] = { 'k', 'i', 'n' };
static const symbol s_0_5[3] = { 'h', 0xE4, 'n' };
static const symbol s_0_6[4] = { 'k', 0xE4, 0xE4, 'n' };
static const symbol s_0_7[2] = { 'k', 'o' };
static const symbol s_0_8[2] = { 'p', 0xE4 };
static const symbol s_0_9[2] = { 'k', 0xF6 };
static const struct among a_0[10] = {
{ 2, s_0_0, 0, 1, 0},
{ 3, s_0_1, 0, 2, 0},
{ 4, s_0_2, 0, 1, 0},
{ 3, s_0_3, 0, 1, 0},
{ 3, s_0_4, 0, 1, 0},
{ 3, s_0_5, 0, 1, 0},
{ 4, s_0_6, 0, 1, 0},
{ 2, s_0_7, 0, 1, 0},
{ 2, s_0_8, 0, 1, 0},
{ 2, s_0_9, 0, 1, 0}
};

static const symbol s_1_0[3] = { 'l', 'l', 'a' };
static const symbol s_1_1[2] = { 'n', 'a' };
static const symbol s_1_2[3] = { 's', 's', 'a' };
static const symbol s_1_3[2] = { 't', 'a' };
static const symbol s_1_4[3] = { 'l', 't', 'a' };
static const symbol s_1_5[3] = { 's', 't', 'a' };
static const struct among a_1[6] = {
{ 3, s_1_0, 0, -1, 0},
{ 2, s_1_1, 0, -1, 0},
{ 3, s_1_2, 0, -1, 0},
{ 2, s_1_3, 0, -1, 0},
{ 3, s_1_4, -1, -1, 0},
{ 3, s_1_5, -2, -1, 0}
};

static const symbol s_2_0[3] = { 'l', 'l', 0xE4 };
static const symbol s_2_1[2] = { 'n', 0xE4 };
static const symbol s_2_2[3] = { 's', 's', 0xE4 };
static const symbol s_2_3[2] = { 't', 0xE4 };
static const symbol s_2_4[3] = { 'l', 't', 0xE4 };
static const symbol s_2_5[3] = { 's', 't', 0xE4 };
static const struct among a_2[6] = {
{ 3, s_2_0, 0, -1, 0},
{ 2, s_2_1, 0, -1, 0},
{ 3, s_2_2, 0, -1, 0},
{ 2, s_2_3, 0, -1, 0},
{ 3, s_2_4, -1, -1, 0},
{ 3, s_2_5, -2, -1, 0}
};

static const symbol s_3_0[3] = { 'l', 'l', 'e' };
static const symbol s_3_1[3] = { 'i', 'n', 'e' };
static const struct among a_3[2] = {
{ 3, s_3_0, 0, -1, 0},
{ 3, s_3_1, 0, -1, 0}
};

static const symbol s_4_0[3] = { 'n', 's', 'a' };
static const symbol s_4_1[3] = { 'm', 'm', 'e' };
static const symbol s_4_2[3] = { 'n', 'n', 'e' };
static const symbol s_4_3[2] = { 'n', 'i' };
static const symbol s_4_4[2] = { 's', 'i' };
static const symbol s_4_5[2] = { 'a', 'n' };
static const symbol s_4_6[2] = { 'e', 'n' };
static const symbol s_4_7[2] = { 0xE4, 'n' };
static const symbol s_4_8[3] = { 'n', 's', 0xE4 };
static const struct among a_4[9] = {
{ 3, s_4_0, 0, 3, 0},
{ 3, s_4_1, 0, 3, 0},
{ 3, s_4_2, 0, 3, 0},
{ 2, s_4_3, 0, 2, 0},
{ 2, s_4_4, 0, 1, 0},
{ 2, s_4_5, 0, 4, 0},
{ 2, s_4_6, 0, 6, 0},
{ 2, s_4_7, 0, 5, 0},
{ 3, s_4_8, 0, 3, 0}
};

static const symbol s_5_0[2] = { 'a', 'a' };
static const symbol s_5_1[2] = { 'e', 'e' };
static const symbol s_5_2[2] = { 'i', 'i' };
static const symbol s_5_3[2] = { 'o', 'o' };
static const symbol s_5_4[2] = { 'u', 'u' };
static const symbol s_5_5[2] = { 0xE4, 0xE4 };
static const symbol s_5_6[2] = { 0xF6, 0xF6 };
static const struct among a_5[7] = {
{ 2, s_5_0, 0, -1, 0},
{ 2, s_5_1, 0, -1, 0},
{ 2, s_5_2, 0, -1, 0},
{ 2, s_5_3, 0, -1, 0},
{ 2, s_5_4, 0, -1, 0},
{ 2, s_5_5, 0, -1, 0},
{ 2, s_5_6, 0, -1, 0}
};

static const symbol s_6_0[1] = { '\'' };
static const symbol s_6_1[2] = { 'a', 'i' };
static const symbol s_6_2[2] = { 'e', 'i' };
static const symbol s_6_3[2] = { 'i', 'i' };
static const symbol s_6_4[2] = { 'o', 'i' };
static const symbol s_6_5[2] = { 'u', 'i' };
static const symbol s_6_6[2] = { 0xE4, 'i' };
static const symbol s_6_7[2] = { 0xF6, 'i' };
static const struct among a_6[8] = {
{ 1, s_6_0, 0, -1, 0},
{ 2, s_6_1, 0, -1, 0},
{ 2, s_6_2, 0, -1, 0},
{ 2, s_6_3, 0, -1, 0},
{ 2, s_6_4, 0, -1, 0},
{ 2, s_6_5, 0, -1, 0},
{ 2, s_6_6, 0, -1, 0},
{ 2, s_6_7, 0, -1, 0}
};

static const symbol s_7_0[1] = { 'a' };
static const symbol s_7_1[3] = { 'l', 'l', 'a' };
static const symbol s_7_2[2] = { 'n', 'a' };
static const symbol s_7_3[3] = { 's', 's', 'a' };
static const symbol s_7_4[2] = { 't', 'a' };
static const symbol s_7_5[3] = { 'l', 't', 'a' };
static const symbol s_7_6[3] = { 's', 't', 'a' };
static const symbol s_7_7[3] = { 't', 't', 'a' };
static const symbol s_7_8[3] = { 'l', 'l', 'e' };
static const symbol s_7_9[3] = { 'i', 'n', 'e' };
static const symbol s_7_10[3] = { 'k', 's', 'i' };
static const symbol s_7_11[1] = { 'n' };
static const symbol s_7_12[3] = { 'h', 'a', 'n' };
static const symbol s_7_13[3] = { 'd', 'e', 'n' };
static const symbol s_7_14[4] = { 's', 'e', 'e', 'n' };
static const symbol s_7_15[3] = { 'h', 'e', 'n' };
static const symbol s_7_16[4] = { 't', 't', 'e', 'n' };
static const symbol s_7_17[3] = { 'h', 'i', 'n' };
static const symbol s_7_18[4] = { 's', 'i', 'i', 'n' };
static const symbol s_7_19[3] = { 'h', 'o', 'n' };
static const symbol s_7_20[3] = { 'h', 'u', 'n' };
static const symbol s_7_21[3] = { 'h', 0xE4, 'n' };
static const symbol s_7_22[3] = { 'h', 0xF6, 'n' };
static const symbol s_7_23[1] = { 0xE4 };
static const symbol s_7_24[3] = { 'l', 'l', 0xE4 };
static const symbol s_7_25[2] = { 'n', 0xE4 };
static const symbol s_7_26[3] = { 's', 's', 0xE4 };
static const symbol s_7_27[2] = { 't', 0xE4 };
static const symbol s_7_28[3] = { 'l', 't', 0xE4 };
static const symbol s_7_29[3] = { 's', 't', 0xE4 };
static const symbol s_7_30[3] = { 't', 't', 0xE4 };
static const struct among a_7[31] = {
{ 1, s_7_0, 0, 2, 0},
{ 3, s_7_1, -1, -1, 0},
{ 2, s_7_2, -2, -1, 0},
{ 3, s_7_3, -3, -1, 0},
{ 2, s_7_4, -4, -1, 0},
{ 3, s_7_5, -1, -1, 0},
{ 3, s_7_6, -2, -1, 0},
{ 3, s_7_7, -3, 3, 0},
{ 3, s_7_8, 0, -1, 0},
{ 3, s_7_9, 0, -1, 0},
{ 3, s_7_10, 0, -1, 0},
{ 1, s_7_11, 0, 1, 0},
{ 3, s_7_12, -1, -1, 3},
{ 3, s_7_13, -2, -1, 8},
{ 4, s_7_14, -3, -1, 9},
{ 3, s_7_15, -4, -1, 4},
{ 4, s_7_16, -5, -1, 8},
{ 3, s_7_17, -6, -1, 5},
{ 4, s_7_18, -7, -1, 8},
{ 3, s_7_19, -8, -1, 6},
{ 3, s_7_20, -9, -1, 7},
{ 3, s_7_21, -10, -1, 1},
{ 3, s_7_22, -11, -1, 2},
{ 1, s_7_23, 0, 2, 0},
{ 3, s_7_24, -1, -1, 0},
{ 2, s_7_25, -2, -1, 0},
{ 3, s_7_26, -3, -1, 0},
{ 2, s_7_27, -4, -1, 0},
{ 3, s_7_28, -1, -1, 0},
{ 3, s_7_29, -2, -1, 0},
{ 3, s_7_30, -3, 3, 0}
};

static int af_7(struct SN_env * z) {
    switch (z->af) {
        case 1: return r_A_(z);
        case 2: return r_O_(z);
        case 3: return r_A(z);
        case 4: return r_E(z);
        case 5: return r_I(z);
        case 6: return r_O(z);
        case 7: return r_U(z);
        case 8: return r_VI(z);
        case 9: return r_LV(z);
    }
    return -1;
}

static const symbol s_8_0[3] = { 'e', 'j', 'a' };
static const symbol s_8_1[3] = { 'm', 'm', 'a' };
static const symbol s_8_2[4] = { 'i', 'm', 'm', 'a' };
static const symbol s_8_3[3] = { 'm', 'p', 'a' };
static const symbol s_8_4[4] = { 'i', 'm', 'p', 'a' };
static const symbol s_8_5[3] = { 'm', 'm', 'i' };
static const symbol s_8_6[4] = { 'i', 'm', 'm', 'i' };
static const symbol s_8_7[3] = { 'm', 'p', 'i' };
static const symbol s_8_8[4] = { 'i', 'm', 'p', 'i' };
static const symbol s_8_9[3] = { 'e', 'j', 0xE4 };
static const symbol s_8_10[3] = { 'm', 'm', 0xE4 };
static const symbol s_8_11[4] = { 'i', 'm', 'm', 0xE4 };
static const symbol s_8_12[3] = { 'm', 'p', 0xE4 };
static const symbol s_8_13[4] = { 'i', 'm', 'p', 0xE4 };
static const struct among a_8[14] = {
{ 3, s_8_0, 0, -1, 0},
{ 3, s_8_1, 0, 1, 0},
{ 4, s_8_2, -1, -1, 0},
{ 3, s_8_3, 0, 1, 0},
{ 4, s_8_4, -1, -1, 0},
{ 3, s_8_5, 0, 1, 0},
{ 4, s_8_6, -1, -1, 0},
{ 3, s_8_7, 0, 1, 0},
{ 4, s_8_8, -1, -1, 0},
{ 3, s_8_9, 0, -1, 0},
{ 3, s_8_10, 0, 1, 0},
{ 4, s_8_11, -1, -1, 0},
{ 3, s_8_12, 0, 1, 0},
{ 4, s_8_13, -1, -1, 0}
};

static const symbol s_10_0[3] = { 'm', 'm', 'a' };
static const symbol s_10_1[4] = { 'i', 'm', 'm', 'a' };
static const struct among a_10[2] = {
{ 3, s_10_0, 0, 1, 0},
{ 4, s_10_1, -1, -1, 0}
};

static const unsigned char g_AEI[] = { 17, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8 };

static const unsigned char g_C[] = { 119, 223, 119, 1 };

static const unsigned char g_v[] = { 17, 65, 16, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32 };

static const unsigned char g_particle_end[] = { 17, 97, 24, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 32 };

static int r_LV(struct SN_env * z) {
    return find_among_b(z, a_5, 7, 0) != 0;
}

static int r_VI(struct SN_env * z) {
    if (z->c <= z->lb || (z->p[z->c - 1] != 39 && z->p[z->c - 1] != 105)) return 0;
    return find_among_b(z, a_6, 8, 0) != 0;
}

static int r_A(struct SN_env * z) {
    do {
        if (z->c <= z->lb || z->p[z->c - 1] != 'a') goto lab0;
        z->c--;
        break;
    lab0:
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
        z->c--;
    } while (0);
    return 1;
}

static int r_E(struct SN_env * z) {
    do {
        if (z->c <= z->lb || z->p[z->c - 1] != 'e') goto lab0;
        z->c--;
        break;
    lab0:
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
        z->c--;
    } while (0);
    return 1;
}

static int r_I(struct SN_env * z) {
    do {
        if (z->c <= z->lb || z->p[z->c - 1] != 'i') goto lab0;
        z->c--;
        break;
    lab0:
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
        z->c--;
    } while (0);
    return 1;
}

static int r_O(struct SN_env * z) {
    do {
        if (z->c <= z->lb || z->p[z->c - 1] != 'o') goto lab0;
        z->c--;
        break;
    lab0:
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
        z->c--;
    } while (0);
    return 1;
}

static int r_U(struct SN_env * z) {
    do {
        if (z->c <= z->lb || z->p[z->c - 1] != 'u') goto lab0;
        z->c--;
        break;
    lab0:
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
        z->c--;
    } while (0);
    return 1;
}

static int r_A_(struct SN_env * z) {
    do {
        if (z->c <= z->lb || z->p[z->c - 1] != 0xE4) goto lab0;
        z->c--;
        break;
    lab0:
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
        z->c--;
    } while (0);
    return 1;
}

static int r_O_(struct SN_env * z) {
    do {
        if (z->c <= z->lb || z->p[z->c - 1] != 0xF6) goto lab0;
        z->c--;
        break;
    lab0:
        if (z->c <= z->lb || z->p[z->c - 1] != 0xF8) goto lab1;
        z->c--;
        break;
    lab1:
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') return 0;
        z->c--;
    } while (0);
    return 1;
}

extern int finnish_stem(struct SN_env * z) {
    int among_var;
    int b_ending_removed;
    int i_p2;
    int i_p1;
    {
        int v_1 = z->c;
        i_p1 = z->l;
        i_p2 = z->l;
        {
            int ret = out_grouping(z, g_v, 97, 246, 1);
            if (ret < 0) goto lab0;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 246, 1);
            if (ret < 0) goto lab0;
            z->c += ret;
        }
        i_p1 = z->c;
        {
            int ret = out_grouping(z, g_v, 97, 246, 1);
            if (ret < 0) goto lab0;
            z->c += ret;
        }
        {
            int ret = in_grouping(z, g_v, 97, 246, 1);
            if (ret < 0) goto lab0;
            z->c += ret;
        }
        i_p2 = z->c;
    lab0:
        z->c = v_1;
    }
    b_ending_removed = 0;
    z->lb = z->c; z->c = z->l;
    {
        int v_2 = z->l - z->c;
        {
            int v_3;
            if (z->c < i_p1) goto lab1;
            v_3 = z->lb; z->lb = i_p1;
            z->ket = z->c;
            among_var = find_among_b(z, a_0, 10, 0);
            if (!among_var) { z->lb = v_3; goto lab1; }
            z->bra = z->c;
            z->lb = v_3;
        }
        switch (among_var) {
            case 1:
                if (in_grouping_b(z, g_particle_end, 97, 246, 0)) goto lab1;
                break;
            case 2:
                if (i_p2 > z->c) goto lab1;
                break;
        }
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab1:
        z->c = z->l - v_2;
    }
    {
        int v_4 = z->l - z->c;
        {
            int v_5;
            if (z->c < i_p1) goto lab2;
            v_5 = z->lb; z->lb = i_p1;
            z->ket = z->c;
            among_var = find_among_b(z, a_4, 9, 0);
            if (!among_var) { z->lb = v_5; goto lab2; }
            z->bra = z->c;
            z->lb = v_5;
        }
        switch (among_var) {
            case 1:
                if (z->c <= z->lb || z->p[z->c - 1] != 'k') goto lab3;
                z->c--;
                goto lab2;
            lab3:
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
                z->ket = z->c;
                if (!(eq_s_b(z, 3, s_0))) goto lab2;
                z->bra = z->c;
                {
                    int ret = slice_from_s(z, 3, s_1);
                    if (ret < 0) return ret;
                }
                break;
            case 3:
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 4:
                if (z->c - 1 <= z->lb || z->p[z->c - 1] != 97) goto lab2;
                if (!find_among_b(z, a_1, 6, 0)) goto lab2;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 5:
                if (z->c - 1 <= z->lb || z->p[z->c - 1] != 228) goto lab2;
                if (!find_among_b(z, a_2, 6, 0)) goto lab2;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            case 6:
                if (z->c - 2 <= z->lb || z->p[z->c - 1] != 101) goto lab2;
                if (!find_among_b(z, a_3, 2, 0)) goto lab2;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
        }
    lab2:
        z->c = z->l - v_4;
    }
    {
        int v_6 = z->l - z->c;
        {
            int v_7;
            if (z->c < i_p1) goto lab4;
            v_7 = z->lb; z->lb = i_p1;
            z->ket = z->c;
            among_var = find_among_b(z, a_7, 31, af_7);
            if (!among_var) { z->lb = v_7; goto lab4; }
            z->bra = z->c;
            z->lb = v_7;
        }
        switch (among_var) {
            case 1:
                {
                    int v_8 = z->l - z->c;
                    {
                        int v_9 = z->l - z->c;
                        do {
                            int v_10 = z->l - z->c;
                            if (!r_LV(z)) goto lab6;
                            break;
                        lab6:
                            z->c = z->l - v_10;
                            if (!(eq_s_b(z, 2, s_2))) { z->c = z->l - v_8; goto lab5; }
                        } while (0);
                        z->c = z->l - v_9;
                        if (z->c <= z->lb) { z->c = z->l - v_8; goto lab5; }
                        z->c--;
                    }
                    z->bra = z->c;
                lab5:
                    ;
                }
                break;
            case 2:
                if (in_grouping_b(z, g_v, 97, 246, 0)) goto lab4;
                if (in_grouping_b(z, g_C, 98, 122, 0)) goto lab4;
                break;
            case 3:
                if (z->c <= z->lb || z->p[z->c - 1] != 'e') goto lab4;
                z->c--;
                break;
        }
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
        b_ending_removed = 1;
    lab4:
        z->c = z->l - v_6;
    }
    {
        int v_11 = z->l - z->c;
        {
            int v_12;
            if (z->c < i_p2) goto lab7;
            v_12 = z->lb; z->lb = i_p2;
            z->ket = z->c;
            among_var = find_among_b(z, a_8, 14, 0);
            if (!among_var) { z->lb = v_12; goto lab7; }
            z->bra = z->c;
            z->lb = v_12;
        }
        switch (among_var) {
            case 1:
                if (!(eq_s_b(z, 2, s_3))) goto lab8;
                goto lab7;
            lab8:
                break;
        }
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab7:
        z->c = z->l - v_11;
    }
    do {
        if (!b_ending_removed) goto lab9;
        {
            int v_13 = z->l - z->c;
            {
                int v_14;
                if (z->c < i_p1) goto lab10;
                v_14 = z->lb; z->lb = i_p1;
                z->ket = z->c;
                if (z->c <= z->lb || (z->p[z->c - 1] != 105 && z->p[z->c - 1] != 106)) { z->lb = v_14; goto lab10; }
                z->c--;
                z->bra = z->c;
                z->lb = v_14;
            }
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab10:
            z->c = z->l - v_13;
        }
        break;
    lab9:
        {
            int v_15 = z->l - z->c;
            {
                int v_16;
                if (z->c < i_p1) goto lab11;
                v_16 = z->lb; z->lb = i_p1;
                z->ket = z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 't') { z->lb = v_16; goto lab11; }
                z->c--;
                z->bra = z->c;
                {
                    int v_17 = z->l - z->c;
                    if (in_grouping_b(z, g_v, 97, 246, 0)) { z->lb = v_16; goto lab11; }
                    z->c = z->l - v_17;
                }
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                z->lb = v_16;
            }
            {
                int v_18;
                if (z->c < i_p2) goto lab11;
                v_18 = z->lb; z->lb = i_p2;
                z->ket = z->c;
                if (z->c - 2 <= z->lb || z->p[z->c - 1] != 97) { z->lb = v_18; goto lab11; }
                among_var = find_among_b(z, a_10, 2, 0);
                if (!among_var) { z->lb = v_18; goto lab11; }
                z->bra = z->c;
                z->lb = v_18;
            }
            switch (among_var) {
                case 1:
                    if (!(eq_s_b(z, 2, s_4))) goto lab12;
                    goto lab11;
                lab12:
                    break;
            }
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab11:
            z->c = z->l - v_15;
        }
    } while (0);
    {
        int v_19 = z->l - z->c;
        {
            int v_20;
            if (z->c < i_p1) goto lab13;
            v_20 = z->lb; z->lb = i_p1;
            {
                int v_21 = z->l - z->c;
                {
                    int v_22 = z->l - z->c;
                    if (!r_LV(z)) goto lab14;
                    z->c = z->l - v_22;
                    z->ket = z->c;
                    if (z->c <= z->lb) goto lab14;
                    z->c--;
                    z->bra = z->c;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                }
            lab14:
                z->c = z->l - v_21;
            }
            {
                int v_23 = z->l - z->c;
                z->ket = z->c;
                if (in_grouping_b(z, g_AEI, 97, 228, 0)) goto lab15;
                z->bra = z->c;
                if (in_grouping_b(z, g_C, 98, 122, 0)) goto lab15;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
            lab15:
                z->c = z->l - v_23;
            }
            {
                int v_24 = z->l - z->c;
                z->ket = z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 'j') goto lab16;
                z->c--;
                z->bra = z->c;
                do {
                    if (z->c <= z->lb || z->p[z->c - 1] != 'o') goto lab17;
                    z->c--;
                    break;
                lab17:
                    if (z->c <= z->lb || z->p[z->c - 1] != 'u') goto lab16;
                    z->c--;
                } while (0);
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
            lab16:
                z->c = z->l - v_24;
            }
            {
                int v_25 = z->l - z->c;
                z->ket = z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 'o') goto lab18;
                z->c--;
                z->bra = z->c;
                if (z->c <= z->lb || z->p[z->c - 1] != 'j') goto lab18;
                z->c--;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
            lab18:
                z->c = z->l - v_25;
            }
            z->lb = v_20;
        }
        {
            int v_26 = z->l - z->c;
            if (in_grouping_b(z, g_v, 97, 246, 1) < 0) goto lab19;
            z->ket = z->c;
            if (in_grouping_b(z, g_C, 98, 122, 0)) goto lab19;
            z->bra = z->c;
            {
                int ret = slice_to(z, &((SN_local *)z)->s_x);
                if (ret < 0) return ret;
            }
            if (!(eq_v_b(z, ((SN_local *)z)->s_x))) goto lab19;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab19:
            z->c = z->l - v_26;
        }
        z->ket = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] != '\'') goto lab13;
        z->c--;
        z->bra = z->c;
        {
            int ret = slice_del(z);
            if (ret < 0) return ret;
        }
    lab13:
        z->c = z->l - v_19;
    }
    z->c = z->lb;
    return 1;
}

extern struct SN_env * finnish_create_env(void) {
    struct SN_env * z = SN_new_env(sizeof(SN_local));
    if (z) {
        if ((((SN_local *)z)->s_x = create_s()) == NULL) {
            finnish_close_env(z);
            return NULL;
        }
    }
    return z;
}

extern void finnish_close_env(struct SN_env * z) {
    if (!z) return;
    lose_s(((SN_local *)z)->s_x);
    SN_delete_env(z);
}

