/*
 * Generated from algorithms/arabic.sbl by the Snowball compiler 3.1.1, with each symbol widened to a
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

#include "arabic_stemmer.h"

#include <stddef.h>

#include "./snowball_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif
extern int arabic_stem(struct SN_env * z);
#ifdef __cplusplus
}
#endif

static int r_Suffix_Verb_Step2a(struct SN_env * z);
static int r_Suffix_Noun_Step2c1(struct SN_env * z);
static int r_Suffix_Noun_Step2b(struct SN_env * z);
static int r_Suffix_Noun_Step2a(struct SN_env * z);

static const symbol s_0[] = { 0x627, 0x62A };
static const symbol s_1[] = { '0' };
static const symbol s_2[] = { '1' };
static const symbol s_3[] = { '2' };
static const symbol s_4[] = { '3' };
static const symbol s_5[] = { '4' };
static const symbol s_6[] = { '5' };
static const symbol s_7[] = { '6' };
static const symbol s_8[] = { '7' };
static const symbol s_9[] = { '8' };
static const symbol s_10[] = { '9' };
static const symbol s_11[] = { 0x621 };
static const symbol s_12[] = { 0x623 };
static const symbol s_13[] = { 0x625 };
static const symbol s_14[] = { 0x626 };
static const symbol s_15[] = { 0x622 };
static const symbol s_16[] = { 0x624 };
static const symbol s_17[] = { 0x627 };
static const symbol s_18[] = { 0x628 };
static const symbol s_19[] = { 0x629 };
static const symbol s_20[] = { 0x62A };
static const symbol s_21[] = { 0x62B };
static const symbol s_22[] = { 0x62C };
static const symbol s_23[] = { 0x62D };
static const symbol s_24[] = { 0x62E };
static const symbol s_25[] = { 0x62F };
static const symbol s_26[] = { 0x630 };
static const symbol s_27[] = { 0x631 };
static const symbol s_28[] = { 0x632 };
static const symbol s_29[] = { 0x633 };
static const symbol s_30[] = { 0x634 };
static const symbol s_31[] = { 0x635 };
static const symbol s_32[] = { 0x636 };
static const symbol s_33[] = { 0x637 };
static const symbol s_34[] = { 0x638 };
static const symbol s_35[] = { 0x639 };
static const symbol s_36[] = { 0x63A };
static const symbol s_37[] = { 0x641 };
static const symbol s_38[] = { 0x642 };
static const symbol s_39[] = { 0x643 };
static const symbol s_40[] = { 0x644 };
static const symbol s_41[] = { 0x645 };
static const symbol s_42[] = { 0x646 };
static const symbol s_43[] = { 0x647 };
static const symbol s_44[] = { 0x648 };
static const symbol s_45[] = { 0x649 };
static const symbol s_46[] = { 0x64A };
static const symbol s_47[] = { 0x644, 0x627 };
static const symbol s_48[] = { 0x644, 0x623 };
static const symbol s_49[] = { 0x644, 0x625 };
static const symbol s_50[] = { 0x644, 0x622 };
static const symbol s_51[] = { 0x64A };
static const symbol s_52[] = { 0x623 };
static const symbol s_53[] = { 0x622 };
static const symbol s_54[] = { 0x627 };
static const symbol s_55[] = { 0x625 };
static const symbol s_56[] = { 0x628 };
static const symbol s_57[] = { 0x643 };
static const symbol s_58[] = { 0x64A };
static const symbol s_59[] = { 0x62A };
static const symbol s_60[] = { 0x646 };
static const symbol s_61[] = { 0x623 };
static const symbol s_62[] = { 0x627, 0x633, 0x62A };
static const symbol s_63[] = { 0x621 };
static const symbol s_64[] = { 0x627 };
static const symbol s_65[] = { 0x648 };
static const symbol s_66[] = { 0x64A };

static const symbol s_0_0[1] = { 0x640 };
static const symbol s_0_1[1] = { 0x64B };
static const symbol s_0_2[1] = { 0x64C };
static const symbol s_0_3[1] = { 0x64D };
static const symbol s_0_4[1] = { 0x64E };
static const symbol s_0_5[1] = { 0x64F };
static const symbol s_0_6[1] = { 0x650 };
static const symbol s_0_7[1] = { 0x651 };
static const symbol s_0_8[1] = { 0x652 };
static const symbol s_0_9[1] = { 0x660 };
static const symbol s_0_10[1] = { 0x661 };
static const symbol s_0_11[1] = { 0x662 };
static const symbol s_0_12[1] = { 0x663 };
static const symbol s_0_13[1] = { 0x664 };
static const symbol s_0_14[1] = { 0x665 };
static const symbol s_0_15[1] = { 0x666 };
static const symbol s_0_16[1] = { 0x667 };
static const symbol s_0_17[1] = { 0x668 };
static const symbol s_0_18[1] = { 0x669 };
static const symbol s_0_19[1] = { 0xFE80 };
static const symbol s_0_20[1] = { 0xFE81 };
static const symbol s_0_21[1] = { 0xFE82 };
static const symbol s_0_22[1] = { 0xFE83 };
static const symbol s_0_23[1] = { 0xFE84 };
static const symbol s_0_24[1] = { 0xFE85 };
static const symbol s_0_25[1] = { 0xFE86 };
static const symbol s_0_26[1] = { 0xFE87 };
static const symbol s_0_27[1] = { 0xFE88 };
static const symbol s_0_28[1] = { 0xFE89 };
static const symbol s_0_29[1] = { 0xFE8A };
static const symbol s_0_30[1] = { 0xFE8B };
static const symbol s_0_31[1] = { 0xFE8C };
static const symbol s_0_32[1] = { 0xFE8D };
static const symbol s_0_33[1] = { 0xFE8E };
static const symbol s_0_34[1] = { 0xFE8F };
static const symbol s_0_35[1] = { 0xFE90 };
static const symbol s_0_36[1] = { 0xFE91 };
static const symbol s_0_37[1] = { 0xFE92 };
static const symbol s_0_38[1] = { 0xFE93 };
static const symbol s_0_39[1] = { 0xFE94 };
static const symbol s_0_40[1] = { 0xFE95 };
static const symbol s_0_41[1] = { 0xFE96 };
static const symbol s_0_42[1] = { 0xFE97 };
static const symbol s_0_43[1] = { 0xFE98 };
static const symbol s_0_44[1] = { 0xFE99 };
static const symbol s_0_45[1] = { 0xFE9A };
static const symbol s_0_46[1] = { 0xFE9B };
static const symbol s_0_47[1] = { 0xFE9C };
static const symbol s_0_48[1] = { 0xFE9D };
static const symbol s_0_49[1] = { 0xFE9E };
static const symbol s_0_50[1] = { 0xFE9F };
static const symbol s_0_51[1] = { 0xFEA0 };
static const symbol s_0_52[1] = { 0xFEA1 };
static const symbol s_0_53[1] = { 0xFEA2 };
static const symbol s_0_54[1] = { 0xFEA3 };
static const symbol s_0_55[1] = { 0xFEA4 };
static const symbol s_0_56[1] = { 0xFEA5 };
static const symbol s_0_57[1] = { 0xFEA6 };
static const symbol s_0_58[1] = { 0xFEA7 };
static const symbol s_0_59[1] = { 0xFEA8 };
static const symbol s_0_60[1] = { 0xFEA9 };
static const symbol s_0_61[1] = { 0xFEAA };
static const symbol s_0_62[1] = { 0xFEAB };
static const symbol s_0_63[1] = { 0xFEAC };
static const symbol s_0_64[1] = { 0xFEAD };
static const symbol s_0_65[1] = { 0xFEAE };
static const symbol s_0_66[1] = { 0xFEAF };
static const symbol s_0_67[1] = { 0xFEB0 };
static const symbol s_0_68[1] = { 0xFEB1 };
static const symbol s_0_69[1] = { 0xFEB2 };
static const symbol s_0_70[1] = { 0xFEB3 };
static const symbol s_0_71[1] = { 0xFEB4 };
static const symbol s_0_72[1] = { 0xFEB5 };
static const symbol s_0_73[1] = { 0xFEB6 };
static const symbol s_0_74[1] = { 0xFEB7 };
static const symbol s_0_75[1] = { 0xFEB8 };
static const symbol s_0_76[1] = { 0xFEB9 };
static const symbol s_0_77[1] = { 0xFEBA };
static const symbol s_0_78[1] = { 0xFEBB };
static const symbol s_0_79[1] = { 0xFEBC };
static const symbol s_0_80[1] = { 0xFEBD };
static const symbol s_0_81[1] = { 0xFEBE };
static const symbol s_0_82[1] = { 0xFEBF };
static const symbol s_0_83[1] = { 0xFEC0 };
static const symbol s_0_84[1] = { 0xFEC1 };
static const symbol s_0_85[1] = { 0xFEC2 };
static const symbol s_0_86[1] = { 0xFEC3 };
static const symbol s_0_87[1] = { 0xFEC4 };
static const symbol s_0_88[1] = { 0xFEC5 };
static const symbol s_0_89[1] = { 0xFEC6 };
static const symbol s_0_90[1] = { 0xFEC7 };
static const symbol s_0_91[1] = { 0xFEC8 };
static const symbol s_0_92[1] = { 0xFEC9 };
static const symbol s_0_93[1] = { 0xFECA };
static const symbol s_0_94[1] = { 0xFECB };
static const symbol s_0_95[1] = { 0xFECC };
static const symbol s_0_96[1] = { 0xFECD };
static const symbol s_0_97[1] = { 0xFECE };
static const symbol s_0_98[1] = { 0xFECF };
static const symbol s_0_99[1] = { 0xFED0 };
static const symbol s_0_100[1] = { 0xFED1 };
static const symbol s_0_101[1] = { 0xFED2 };
static const symbol s_0_102[1] = { 0xFED3 };
static const symbol s_0_103[1] = { 0xFED4 };
static const symbol s_0_104[1] = { 0xFED5 };
static const symbol s_0_105[1] = { 0xFED6 };
static const symbol s_0_106[1] = { 0xFED7 };
static const symbol s_0_107[1] = { 0xFED8 };
static const symbol s_0_108[1] = { 0xFED9 };
static const symbol s_0_109[1] = { 0xFEDA };
static const symbol s_0_110[1] = { 0xFEDB };
static const symbol s_0_111[1] = { 0xFEDC };
static const symbol s_0_112[1] = { 0xFEDD };
static const symbol s_0_113[1] = { 0xFEDE };
static const symbol s_0_114[1] = { 0xFEDF };
static const symbol s_0_115[1] = { 0xFEE0 };
static const symbol s_0_116[1] = { 0xFEE1 };
static const symbol s_0_117[1] = { 0xFEE2 };
static const symbol s_0_118[1] = { 0xFEE3 };
static const symbol s_0_119[1] = { 0xFEE4 };
static const symbol s_0_120[1] = { 0xFEE5 };
static const symbol s_0_121[1] = { 0xFEE6 };
static const symbol s_0_122[1] = { 0xFEE7 };
static const symbol s_0_123[1] = { 0xFEE8 };
static const symbol s_0_124[1] = { 0xFEE9 };
static const symbol s_0_125[1] = { 0xFEEA };
static const symbol s_0_126[1] = { 0xFEEB };
static const symbol s_0_127[1] = { 0xFEEC };
static const symbol s_0_128[1] = { 0xFEED };
static const symbol s_0_129[1] = { 0xFEEE };
static const symbol s_0_130[1] = { 0xFEEF };
static const symbol s_0_131[1] = { 0xFEF0 };
static const symbol s_0_132[1] = { 0xFEF1 };
static const symbol s_0_133[1] = { 0xFEF2 };
static const symbol s_0_134[1] = { 0xFEF3 };
static const symbol s_0_135[1] = { 0xFEF4 };
static const symbol s_0_136[1] = { 0xFEF5 };
static const symbol s_0_137[1] = { 0xFEF6 };
static const symbol s_0_138[1] = { 0xFEF7 };
static const symbol s_0_139[1] = { 0xFEF8 };
static const symbol s_0_140[1] = { 0xFEF9 };
static const symbol s_0_141[1] = { 0xFEFA };
static const symbol s_0_142[1] = { 0xFEFB };
static const symbol s_0_143[1] = { 0xFEFC };
static const struct among a_0[144] = {
{ 1, s_0_0, 0, 1, 0},
{ 1, s_0_1, 0, 1, 0},
{ 1, s_0_2, 0, 1, 0},
{ 1, s_0_3, 0, 1, 0},
{ 1, s_0_4, 0, 1, 0},
{ 1, s_0_5, 0, 1, 0},
{ 1, s_0_6, 0, 1, 0},
{ 1, s_0_7, 0, 1, 0},
{ 1, s_0_8, 0, 1, 0},
{ 1, s_0_9, 0, 2, 0},
{ 1, s_0_10, 0, 3, 0},
{ 1, s_0_11, 0, 4, 0},
{ 1, s_0_12, 0, 5, 0},
{ 1, s_0_13, 0, 6, 0},
{ 1, s_0_14, 0, 7, 0},
{ 1, s_0_15, 0, 8, 0},
{ 1, s_0_16, 0, 9, 0},
{ 1, s_0_17, 0, 10, 0},
{ 1, s_0_18, 0, 11, 0},
{ 1, s_0_19, 0, 12, 0},
{ 1, s_0_20, 0, 16, 0},
{ 1, s_0_21, 0, 16, 0},
{ 1, s_0_22, 0, 13, 0},
{ 1, s_0_23, 0, 13, 0},
{ 1, s_0_24, 0, 17, 0},
{ 1, s_0_25, 0, 17, 0},
{ 1, s_0_26, 0, 14, 0},
{ 1, s_0_27, 0, 14, 0},
{ 1, s_0_28, 0, 15, 0},
{ 1, s_0_29, 0, 15, 0},
{ 1, s_0_30, 0, 15, 0},
{ 1, s_0_31, 0, 15, 0},
{ 1, s_0_32, 0, 18, 0},
{ 1, s_0_33, 0, 18, 0},
{ 1, s_0_34, 0, 19, 0},
{ 1, s_0_35, 0, 19, 0},
{ 1, s_0_36, 0, 19, 0},
{ 1, s_0_37, 0, 19, 0},
{ 1, s_0_38, 0, 20, 0},
{ 1, s_0_39, 0, 20, 0},
{ 1, s_0_40, 0, 21, 0},
{ 1, s_0_41, 0, 21, 0},
{ 1, s_0_42, 0, 21, 0},
{ 1, s_0_43, 0, 21, 0},
{ 1, s_0_44, 0, 22, 0},
{ 1, s_0_45, 0, 22, 0},
{ 1, s_0_46, 0, 22, 0},
{ 1, s_0_47, 0, 22, 0},
{ 1, s_0_48, 0, 23, 0},
{ 1, s_0_49, 0, 23, 0},
{ 1, s_0_50, 0, 23, 0},
{ 1, s_0_51, 0, 23, 0},
{ 1, s_0_52, 0, 24, 0},
{ 1, s_0_53, 0, 24, 0},
{ 1, s_0_54, 0, 24, 0},
{ 1, s_0_55, 0, 24, 0},
{ 1, s_0_56, 0, 25, 0},
{ 1, s_0_57, 0, 25, 0},
{ 1, s_0_58, 0, 25, 0},
{ 1, s_0_59, 0, 25, 0},
{ 1, s_0_60, 0, 26, 0},
{ 1, s_0_61, 0, 26, 0},
{ 1, s_0_62, 0, 27, 0},
{ 1, s_0_63, 0, 27, 0},
{ 1, s_0_64, 0, 28, 0},
{ 1, s_0_65, 0, 28, 0},
{ 1, s_0_66, 0, 29, 0},
{ 1, s_0_67, 0, 29, 0},
{ 1, s_0_68, 0, 30, 0},
{ 1, s_0_69, 0, 30, 0},
{ 1, s_0_70, 0, 30, 0},
{ 1, s_0_71, 0, 30, 0},
{ 1, s_0_72, 0, 31, 0},
{ 1, s_0_73, 0, 31, 0},
{ 1, s_0_74, 0, 31, 0},
{ 1, s_0_75, 0, 31, 0},
{ 1, s_0_76, 0, 32, 0},
{ 1, s_0_77, 0, 32, 0},
{ 1, s_0_78, 0, 32, 0},
{ 1, s_0_79, 0, 32, 0},
{ 1, s_0_80, 0, 33, 0},
{ 1, s_0_81, 0, 33, 0},
{ 1, s_0_82, 0, 33, 0},
{ 1, s_0_83, 0, 33, 0},
{ 1, s_0_84, 0, 34, 0},
{ 1, s_0_85, 0, 34, 0},
{ 1, s_0_86, 0, 34, 0},
{ 1, s_0_87, 0, 34, 0},
{ 1, s_0_88, 0, 35, 0},
{ 1, s_0_89, 0, 35, 0},
{ 1, s_0_90, 0, 35, 0},
{ 1, s_0_91, 0, 35, 0},
{ 1, s_0_92, 0, 36, 0},
{ 1, s_0_93, 0, 36, 0},
{ 1, s_0_94, 0, 36, 0},
{ 1, s_0_95, 0, 36, 0},
{ 1, s_0_96, 0, 37, 0},
{ 1, s_0_97, 0, 37, 0},
{ 1, s_0_98, 0, 37, 0},
{ 1, s_0_99, 0, 37, 0},
{ 1, s_0_100, 0, 38, 0},
{ 1, s_0_101, 0, 38, 0},
{ 1, s_0_102, 0, 38, 0},
{ 1, s_0_103, 0, 38, 0},
{ 1, s_0_104, 0, 39, 0},
{ 1, s_0_105, 0, 39, 0},
{ 1, s_0_106, 0, 39, 0},
{ 1, s_0_107, 0, 39, 0},
{ 1, s_0_108, 0, 40, 0},
{ 1, s_0_109, 0, 40, 0},
{ 1, s_0_110, 0, 40, 0},
{ 1, s_0_111, 0, 40, 0},
{ 1, s_0_112, 0, 41, 0},
{ 1, s_0_113, 0, 41, 0},
{ 1, s_0_114, 0, 41, 0},
{ 1, s_0_115, 0, 41, 0},
{ 1, s_0_116, 0, 42, 0},
{ 1, s_0_117, 0, 42, 0},
{ 1, s_0_118, 0, 42, 0},
{ 1, s_0_119, 0, 42, 0},
{ 1, s_0_120, 0, 43, 0},
{ 1, s_0_121, 0, 43, 0},
{ 1, s_0_122, 0, 43, 0},
{ 1, s_0_123, 0, 43, 0},
{ 1, s_0_124, 0, 44, 0},
{ 1, s_0_125, 0, 44, 0},
{ 1, s_0_126, 0, 44, 0},
{ 1, s_0_127, 0, 44, 0},
{ 1, s_0_128, 0, 45, 0},
{ 1, s_0_129, 0, 45, 0},
{ 1, s_0_130, 0, 46, 0},
{ 1, s_0_131, 0, 46, 0},
{ 1, s_0_132, 0, 47, 0},
{ 1, s_0_133, 0, 47, 0},
{ 1, s_0_134, 0, 47, 0},
{ 1, s_0_135, 0, 47, 0},
{ 1, s_0_136, 0, 51, 0},
{ 1, s_0_137, 0, 51, 0},
{ 1, s_0_138, 0, 49, 0},
{ 1, s_0_139, 0, 49, 0},
{ 1, s_0_140, 0, 50, 0},
{ 1, s_0_141, 0, 50, 0},
{ 1, s_0_142, 0, 48, 0},
{ 1, s_0_143, 0, 48, 0}
};

static const symbol s_2_0[1] = { 0x622 };
static const symbol s_2_1[1] = { 0x623 };
static const symbol s_2_2[1] = { 0x624 };
static const symbol s_2_3[1] = { 0x625 };
static const symbol s_2_4[1] = { 0x626 };
static const struct among a_2[5] = {
{ 1, s_2_0, 0, 1, 0},
{ 1, s_2_1, 0, 1, 0},
{ 1, s_2_2, 0, 2, 0},
{ 1, s_2_3, 0, 1, 0},
{ 1, s_2_4, 0, 3, 0}
};

static const symbol s_3_0[2] = { 0x627, 0x644 };
static const symbol s_3_1[3] = { 0x628, 0x627, 0x644 };
static const symbol s_3_2[3] = { 0x643, 0x627, 0x644 };
static const symbol s_3_3[2] = { 0x644, 0x644 };
static const struct among a_3[4] = {
{ 2, s_3_0, 0, 2, 0},
{ 3, s_3_1, 0, 1, 0},
{ 3, s_3_2, 0, 1, 0},
{ 2, s_3_3, 0, 2, 0}
};

static const symbol s_4_0[2] = { 0x623, 0x622 };
static const symbol s_4_1[2] = { 0x623, 0x623 };
static const symbol s_4_2[2] = { 0x623, 0x624 };
static const symbol s_4_3[2] = { 0x623, 0x625 };
static const symbol s_4_4[2] = { 0x623, 0x627 };
static const struct among a_4[5] = {
{ 2, s_4_0, 0, 2, 0},
{ 2, s_4_1, 0, 1, 0},
{ 2, s_4_2, 0, 1, 0},
{ 2, s_4_3, 0, 4, 0},
{ 2, s_4_4, 0, 3, 0}
};

static const symbol s_6_0[2] = { 0x627, 0x644 };
static const symbol s_6_1[3] = { 0x628, 0x627, 0x644 };
static const symbol s_6_2[3] = { 0x643, 0x627, 0x644 };
static const symbol s_6_3[2] = { 0x644, 0x644 };
static const struct among a_6[4] = {
{ 2, s_6_0, 0, 2, 0},
{ 3, s_6_1, 0, 1, 0},
{ 3, s_6_2, 0, 1, 0},
{ 2, s_6_3, 0, 2, 0}
};

static const symbol s_7_0[1] = { 0x628 };
static const symbol s_7_1[2] = { 0x628, 0x627 };
static const symbol s_7_2[2] = { 0x628, 0x628 };
static const symbol s_7_3[2] = { 0x643, 0x643 };
static const struct among a_7[4] = {
{ 1, s_7_0, 0, 1, 0},
{ 2, s_7_1, -1, -1, 0},
{ 2, s_7_2, -2, 2, 0},
{ 2, s_7_3, 0, 3, 0}
};

static const symbol s_8_0[2] = { 0x633, 0x623 };
static const symbol s_8_1[2] = { 0x633, 0x62A };
static const symbol s_8_2[2] = { 0x633, 0x646 };
static const symbol s_8_3[2] = { 0x633, 0x64A };
static const struct among a_8[4] = {
{ 2, s_8_0, 0, 4, 0},
{ 2, s_8_1, 0, 2, 0},
{ 2, s_8_2, 0, 3, 0},
{ 2, s_8_3, 0, 1, 0}
};

static const symbol s_9_0[3] = { 0x62A, 0x633, 0x62A };
static const symbol s_9_1[3] = { 0x646, 0x633, 0x62A };
static const symbol s_9_2[3] = { 0x64A, 0x633, 0x62A };
static const struct among a_9[3] = {
{ 3, s_9_0, 0, 1, 0},
{ 3, s_9_1, 0, 1, 0},
{ 3, s_9_2, 0, 1, 0}
};

static const symbol s_10_0[3] = { 0x643, 0x645, 0x627 };
static const symbol s_10_1[3] = { 0x647, 0x645, 0x627 };
static const symbol s_10_2[2] = { 0x646, 0x627 };
static const symbol s_10_3[2] = { 0x647, 0x627 };
static const symbol s_10_4[1] = { 0x643 };
static const symbol s_10_5[2] = { 0x643, 0x645 };
static const symbol s_10_6[2] = { 0x647, 0x645 };
static const symbol s_10_7[2] = { 0x647, 0x646 };
static const symbol s_10_8[1] = { 0x647 };
static const symbol s_10_9[1] = { 0x64A };
static const struct among a_10[10] = {
{ 3, s_10_0, 0, 3, 0},
{ 3, s_10_1, 0, 3, 0},
{ 2, s_10_2, 0, 2, 0},
{ 2, s_10_3, 0, 2, 0},
{ 1, s_10_4, 0, 1, 0},
{ 2, s_10_5, 0, 2, 0},
{ 2, s_10_6, 0, 2, 0},
{ 2, s_10_7, 0, 2, 0},
{ 1, s_10_8, 0, 1, 0},
{ 1, s_10_9, 0, 1, 0}
};

static const symbol s_11_0[1] = { 0x627 };
static const symbol s_11_1[1] = { 0x648 };
static const symbol s_11_2[1] = { 0x64A };
static const struct among a_11[3] = {
{ 1, s_11_0, 0, 1, 0},
{ 1, s_11_1, 0, 1, 0},
{ 1, s_11_2, 0, 1, 0}
};

static const symbol s_12_0[3] = { 0x643, 0x645, 0x627 };
static const symbol s_12_1[3] = { 0x647, 0x645, 0x627 };
static const symbol s_12_2[2] = { 0x646, 0x627 };
static const symbol s_12_3[2] = { 0x647, 0x627 };
static const symbol s_12_4[1] = { 0x643 };
static const symbol s_12_5[2] = { 0x643, 0x645 };
static const symbol s_12_6[2] = { 0x647, 0x645 };
static const symbol s_12_7[2] = { 0x643, 0x646 };
static const symbol s_12_8[2] = { 0x647, 0x646 };
static const symbol s_12_9[1] = { 0x647 };
static const symbol s_12_10[3] = { 0x643, 0x645, 0x648 };
static const symbol s_12_11[2] = { 0x646, 0x64A };
static const struct among a_12[12] = {
{ 3, s_12_0, 0, 3, 0},
{ 3, s_12_1, 0, 3, 0},
{ 2, s_12_2, 0, 2, 0},
{ 2, s_12_3, 0, 2, 0},
{ 1, s_12_4, 0, 1, 0},
{ 2, s_12_5, 0, 2, 0},
{ 2, s_12_6, 0, 2, 0},
{ 2, s_12_7, 0, 2, 0},
{ 2, s_12_8, 0, 2, 0},
{ 1, s_12_9, 0, 1, 0},
{ 3, s_12_10, 0, 3, 0},
{ 2, s_12_11, 0, 2, 0}
};

static const symbol s_13_0[1] = { 0x627 };
static const symbol s_13_1[2] = { 0x62A, 0x627 };
static const symbol s_13_2[3] = { 0x62A, 0x645, 0x627 };
static const symbol s_13_3[2] = { 0x646, 0x627 };
static const symbol s_13_4[1] = { 0x62A };
static const symbol s_13_5[1] = { 0x646 };
static const symbol s_13_6[2] = { 0x627, 0x646 };
static const symbol s_13_7[2] = { 0x62A, 0x646 };
static const symbol s_13_8[2] = { 0x648, 0x646 };
static const symbol s_13_9[2] = { 0x64A, 0x646 };
static const symbol s_13_10[1] = { 0x64A };
static const struct among a_13[11] = {
{ 1, s_13_0, 0, 1, 0},
{ 2, s_13_1, -1, 2, 0},
{ 3, s_13_2, -2, 3, 0},
{ 2, s_13_3, -3, 2, 0},
{ 1, s_13_4, 0, 1, 0},
{ 1, s_13_5, 0, 1, 0},
{ 2, s_13_6, -1, 3, 0},
{ 2, s_13_7, -2, 2, 0},
{ 2, s_13_8, -3, 3, 0},
{ 2, s_13_9, -4, 3, 0},
{ 1, s_13_10, 0, 1, 0}
};

static const symbol s_14_0[2] = { 0x648, 0x627 };
static const symbol s_14_1[2] = { 0x62A, 0x645 };
static const struct among a_14[2] = {
{ 2, s_14_0, 0, 1, 0},
{ 2, s_14_1, 0, 1, 0}
};

static const symbol s_15_0[1] = { 0x648 };
static const symbol s_15_1[3] = { 0x62A, 0x645, 0x648 };
static const struct among a_15[2] = {
{ 1, s_15_0, 0, 1, 0},
{ 3, s_15_1, -1, 2, 0}
};

static int r_Suffix_Noun_Step2a(struct SN_env * z) {
    z->ket = z->c;
    if (!find_among_b(z, a_11, 3, 0)) return 0;
    z->bra = z->c;
    if (SIZE(z->p) < 5) return 0;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    return 1;
}

static int r_Suffix_Noun_Step2b(struct SN_env * z) {
    z->ket = z->c;
    if (!(eq_s_b(z, 2, s_0))) return 0;
    z->bra = z->c;
    if (SIZE(z->p) < 5) return 0;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    return 1;
}

static int r_Suffix_Noun_Step2c1(struct SN_env * z) {
    z->ket = z->c;
    if (z->c <= z->lb || z->p[z->c - 1] != 0x62A) return 0;
    z->c--;
    z->bra = z->c;
    if (SIZE(z->p) < 4) return 0;
    {
        int ret = slice_del(z);
        if (ret < 0) return ret;
    }
    return 1;
}

static int r_Suffix_Verb_Step2a(struct SN_env * z) {
    int among_var;
    z->ket = z->c;
    among_var = find_among_b(z, a_13, 11, 0);
    if (!among_var) return 0;
    z->bra = z->c;
    switch (among_var) {
        case 1:
            if (SIZE(z->p) < 4) return 0;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        case 2:
            if (SIZE(z->p) < 5) return 0;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        case 3:
            if (SIZE(z->p) < 6) return 0;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
    }
    return 1;
}

extern int arabic_stem(struct SN_env * z) {
    int among_var;
    int b_is_defined;
    int b_is_verb;
    int b_is_noun;
    b_is_noun = 1;
    b_is_verb = 1;
    b_is_defined = 0;
    {
        int v_1 = z->c;
        z->bra = z->c;
        if (z->c + 1 >= z->l || (z->p[z->c + 1] != 1604 && z->p[z->c + 1] != 1575)) goto lab0;
        among_var = find_among(z, a_3, 4, 0);
        if (!among_var) goto lab0;
        z->ket = z->c;
        switch (among_var) {
            case 1:
                if (SIZE(z->p) < 5) goto lab0;
                b_is_noun = 1;
                b_is_verb = 0;
                b_is_defined = 1;
                break;
            case 2:
                if (SIZE(z->p) < 4) goto lab0;
                b_is_noun = 1;
                b_is_verb = 0;
                b_is_defined = 1;
                break;
        }
    lab0:
        z->c = v_1;
    }
    {
        int v_2 = z->c;
        while (1) {
            int v_3 = z->c;
            do {
                int v_4 = z->c;
                z->bra = z->c;
                among_var = find_among(z, a_0, 144, 0);
                if (!among_var) goto lab4;
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
                            int ret = slice_from_s(z, 1, s_5);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 7:
                        {
                            int ret = slice_from_s(z, 1, s_6);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 8:
                        {
                            int ret = slice_from_s(z, 1, s_7);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 9:
                        {
                            int ret = slice_from_s(z, 1, s_8);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 10:
                        {
                            int ret = slice_from_s(z, 1, s_9);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 11:
                        {
                            int ret = slice_from_s(z, 1, s_10);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 12:
                        {
                            int ret = slice_from_s(z, 1, s_11);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 13:
                        {
                            int ret = slice_from_s(z, 1, s_12);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 14:
                        {
                            int ret = slice_from_s(z, 1, s_13);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 15:
                        {
                            int ret = slice_from_s(z, 1, s_14);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 16:
                        {
                            int ret = slice_from_s(z, 1, s_15);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 17:
                        {
                            int ret = slice_from_s(z, 1, s_16);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 18:
                        {
                            int ret = slice_from_s(z, 1, s_17);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 19:
                        {
                            int ret = slice_from_s(z, 1, s_18);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 20:
                        {
                            int ret = slice_from_s(z, 1, s_19);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 21:
                        {
                            int ret = slice_from_s(z, 1, s_20);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 22:
                        {
                            int ret = slice_from_s(z, 1, s_21);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 23:
                        {
                            int ret = slice_from_s(z, 1, s_22);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 24:
                        {
                            int ret = slice_from_s(z, 1, s_23);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 25:
                        {
                            int ret = slice_from_s(z, 1, s_24);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 26:
                        {
                            int ret = slice_from_s(z, 1, s_25);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 27:
                        {
                            int ret = slice_from_s(z, 1, s_26);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 28:
                        {
                            int ret = slice_from_s(z, 1, s_27);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 29:
                        {
                            int ret = slice_from_s(z, 1, s_28);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 30:
                        {
                            int ret = slice_from_s(z, 1, s_29);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 31:
                        {
                            int ret = slice_from_s(z, 1, s_30);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 32:
                        {
                            int ret = slice_from_s(z, 1, s_31);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 33:
                        {
                            int ret = slice_from_s(z, 1, s_32);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 34:
                        {
                            int ret = slice_from_s(z, 1, s_33);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 35:
                        {
                            int ret = slice_from_s(z, 1, s_34);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 36:
                        {
                            int ret = slice_from_s(z, 1, s_35);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 37:
                        {
                            int ret = slice_from_s(z, 1, s_36);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 38:
                        {
                            int ret = slice_from_s(z, 1, s_37);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 39:
                        {
                            int ret = slice_from_s(z, 1, s_38);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 40:
                        {
                            int ret = slice_from_s(z, 1, s_39);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 41:
                        {
                            int ret = slice_from_s(z, 1, s_40);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 42:
                        {
                            int ret = slice_from_s(z, 1, s_41);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 43:
                        {
                            int ret = slice_from_s(z, 1, s_42);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 44:
                        {
                            int ret = slice_from_s(z, 1, s_43);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 45:
                        {
                            int ret = slice_from_s(z, 1, s_44);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 46:
                        {
                            int ret = slice_from_s(z, 1, s_45);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 47:
                        {
                            int ret = slice_from_s(z, 1, s_46);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 48:
                        {
                            int ret = slice_from_s(z, 2, s_47);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 49:
                        {
                            int ret = slice_from_s(z, 2, s_48);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 50:
                        {
                            int ret = slice_from_s(z, 2, s_49);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 51:
                        {
                            int ret = slice_from_s(z, 2, s_50);
                            if (ret < 0) return ret;
                        }
                        break;
                }
                break;
            lab4:
                z->c = v_4;
                if (z->c >= z->l) goto lab3;
                z->c++;
            } while (0);
            continue;
        lab3:
            z->c = v_3;
            break;
        }
        z->c = v_2;
    }
    z->lb = z->c; z->c = z->l;
    {
        int v_5 = z->l - z->c;
        do {
            int v_6 = z->l - z->c;
            if (!b_is_verb) goto lab6;
            do {
                int v_7 = z->l - z->c;
                {
                    int v_8 = 1;
                    while (1) {
                        int v_9 = z->l - z->c;
                        z->ket = z->c;
                        among_var = find_among_b(z, a_12, 12, 0);
                        if (!among_var) goto lab8;
                        z->bra = z->c;
                        switch (among_var) {
                            case 1:
                                if (SIZE(z->p) < 4) goto lab8;
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                            case 2:
                                if (SIZE(z->p) < 5) goto lab8;
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                            case 3:
                                if (SIZE(z->p) < 6) goto lab8;
                                {
                                    int ret = slice_del(z);
                                    if (ret < 0) return ret;
                                }
                                break;
                        }
                        v_8--;
                        continue;
                    lab8:
                        z->c = z->l - v_9;
                        break;
                    }
                    if (v_8 > 0) goto lab7;
                }
                do {
                    int v_10 = z->l - z->c;
                    {
                        int ret = r_Suffix_Verb_Step2a(z);
                        if (ret == 0) goto lab9;
                        if (ret < 0) return ret;
                    }
                    break;
                lab9:
                    z->c = z->l - v_10;
                    z->ket = z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 1608) goto lab10;
                    among_var = find_among_b(z, a_15, 2, 0);
                    if (!among_var) goto lab10;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            if (SIZE(z->p) < 4) goto lab10;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            if (SIZE(z->p) < 6) goto lab10;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                    }
                    break;
                lab10:
                    z->c = z->l - v_10;
                    if (z->c <= z->lb) goto lab7;
                    z->c--;
                } while (0);
                break;
            lab7:
                z->c = z->l - v_7;
                z->ket = z->c;
                if (z->c - 1 <= z->lb || (z->p[z->c - 1] != 1575 && z->p[z->c - 1] != 1605)) goto lab11;
                if (!find_among_b(z, a_14, 2, 0)) goto lab11;
                z->bra = z->c;
                if (SIZE(z->p) < 5) goto lab11;
                {
                    int ret = slice_del(z);
                    if (ret < 0) return ret;
                }
                break;
            lab11:
                z->c = z->l - v_7;
                {
                    int ret = r_Suffix_Verb_Step2a(z);
                    if (ret == 0) goto lab6;
                    if (ret < 0) return ret;
                }
            } while (0);
            break;
        lab6:
            z->c = z->l - v_6;
            if (!b_is_noun) goto lab12;
            {
                int v_11 = z->l - z->c;
                do {
                    int v_12 = z->l - z->c;
                    z->ket = z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 0x629) goto lab14;
                    z->c--;
                    z->bra = z->c;
                    if (SIZE(z->p) < 4) goto lab14;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                lab14:
                    z->c = z->l - v_12;
                    if (b_is_defined) goto lab15;
                    z->ket = z->c;
                    among_var = find_among_b(z, a_10, 10, 0);
                    if (!among_var) goto lab15;
                    z->bra = z->c;
                    switch (among_var) {
                        case 1:
                            if (SIZE(z->p) < 4) goto lab15;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 2:
                            if (SIZE(z->p) < 5) goto lab15;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                        case 3:
                            if (SIZE(z->p) < 6) goto lab15;
                            {
                                int ret = slice_del(z);
                                if (ret < 0) return ret;
                            }
                            break;
                    }
                    do {
                        int v_13 = z->l - z->c;
                        {
                            int ret = r_Suffix_Noun_Step2a(z);
                            if (ret == 0) goto lab16;
                            if (ret < 0) return ret;
                        }
                        break;
                    lab16:
                        z->c = z->l - v_13;
                        {
                            int ret = r_Suffix_Noun_Step2b(z);
                            if (ret == 0) goto lab17;
                            if (ret < 0) return ret;
                        }
                        break;
                    lab17:
                        z->c = z->l - v_13;
                        {
                            int ret = r_Suffix_Noun_Step2c1(z);
                            if (ret == 0) goto lab18;
                            if (ret < 0) return ret;
                        }
                        break;
                    lab18:
                        z->c = z->l - v_13;
                        if (z->c <= z->lb) goto lab15;
                        z->c--;
                    } while (0);
                    break;
                lab15:
                    z->c = z->l - v_12;
                    z->ket = z->c;
                    if (z->c <= z->lb || z->p[z->c - 1] != 0x646) goto lab19;
                    z->c--;
                    z->bra = z->c;
                    if (SIZE(z->p) < 6) goto lab19;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    do {
                        int v_14 = z->l - z->c;
                        {
                            int ret = r_Suffix_Noun_Step2a(z);
                            if (ret == 0) goto lab20;
                            if (ret < 0) return ret;
                        }
                        break;
                    lab20:
                        z->c = z->l - v_14;
                        {
                            int ret = r_Suffix_Noun_Step2b(z);
                            if (ret == 0) goto lab21;
                            if (ret < 0) return ret;
                        }
                        break;
                    lab21:
                        z->c = z->l - v_14;
                        {
                            int ret = r_Suffix_Noun_Step2c1(z);
                            if (ret == 0) goto lab19;
                            if (ret < 0) return ret;
                        }
                    } while (0);
                    break;
                lab19:
                    z->c = z->l - v_12;
                    if (b_is_defined) goto lab22;
                    {
                        int ret = r_Suffix_Noun_Step2a(z);
                        if (ret == 0) goto lab22;
                        if (ret < 0) return ret;
                    }
                    break;
                lab22:
                    z->c = z->l - v_12;
                    {
                        int ret = r_Suffix_Noun_Step2b(z);
                        if (ret == 0) { z->c = z->l - v_11; goto lab13; }
                        if (ret < 0) return ret;
                    }
                } while (0);
            lab13:
                ;
            }
            z->ket = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 0x64A) goto lab12;
            z->c--;
            z->bra = z->c;
            if (SIZE(z->p) < 3) goto lab12;
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
            break;
        lab12:
            z->c = z->l - v_6;
            z->ket = z->c;
            if (z->c <= z->lb || z->p[z->c - 1] != 0x649) goto lab5;
            z->c--;
            z->bra = z->c;
            {
                int ret = slice_from_s(z, 1, s_51);
                if (ret < 0) return ret;
            }
        } while (0);
    lab5:
        z->c = z->l - v_5;
    }
    z->c = z->lb;
    {
        int v_15 = z->c;
        {
            int v_16 = z->c;
            z->bra = z->c;
            if (z->c + 1 >= z->l || z->p[z->c + 1] >> 5 != 49 || !((188 >> (z->p[z->c + 1] & 0x1f)) & 1)) { z->c = v_16; goto lab24; }
            among_var = find_among(z, a_4, 5, 0);
            if (!among_var) { z->c = v_16; goto lab24; }
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    if (SIZE(z->p) < 4) { z->c = v_16; goto lab24; }
                    {
                        int ret = slice_from_s(z, 1, s_52);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (SIZE(z->p) < 4) { z->c = v_16; goto lab24; }
                    {
                        int ret = slice_from_s(z, 1, s_53);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    if (SIZE(z->p) < 4) { z->c = v_16; goto lab24; }
                    {
                        int ret = slice_from_s(z, 1, s_54);
                        if (ret < 0) return ret;
                    }
                    break;
                case 4:
                    if (SIZE(z->p) < 4) { z->c = v_16; goto lab24; }
                    {
                        int ret = slice_from_s(z, 1, s_55);
                        if (ret < 0) return ret;
                    }
                    break;
            }
        lab24:
            ;
        }
        {
            int v_17 = z->c;
            z->bra = z->c;
            if (z->c >= z->l || (z->p[z->c + 0] != 1601 && z->p[z->c + 0] != 1608)) { z->c = v_17; goto lab25; }
            z->c++;
            z->ket = z->c;
            if (SIZE(z->p) < 4) { z->c = v_17; goto lab25; }
            if (z->c == z->l || z->p[z->c] != 0x627) goto lab26;
            z->c++;
            { z->c = v_17; goto lab25; }
        lab26:
            {
                int ret = slice_del(z);
                if (ret < 0) return ret;
            }
        lab25:
            ;
        }
        do {
            int v_18 = z->c;
            z->bra = z->c;
            if (z->c + 1 >= z->l || (z->p[z->c + 1] != 1604 && z->p[z->c + 1] != 1575)) goto lab27;
            among_var = find_among(z, a_6, 4, 0);
            if (!among_var) goto lab27;
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    if (SIZE(z->p) < 6) goto lab27;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (SIZE(z->p) < 5) goto lab27;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
            }
            break;
        lab27:
            z->c = v_18;
            if (!b_is_noun) goto lab28;
            z->bra = z->c;
            if (z->c >= z->l || (z->p[z->c + 0] != 1576 && z->p[z->c + 0] != 1603)) goto lab28;
            among_var = find_among(z, a_7, 4, 0);
            if (!among_var) goto lab28;
            z->ket = z->c;
            switch (among_var) {
                case 1:
                    if (SIZE(z->p) < 4) goto lab28;
                    {
                        int ret = slice_del(z);
                        if (ret < 0) return ret;
                    }
                    break;
                case 2:
                    if (SIZE(z->p) < 4) goto lab28;
                    {
                        int ret = slice_from_s(z, 1, s_56);
                        if (ret < 0) return ret;
                    }
                    break;
                case 3:
                    if (SIZE(z->p) < 4) goto lab28;
                    {
                        int ret = slice_from_s(z, 1, s_57);
                        if (ret < 0) return ret;
                    }
                    break;
            }
            break;
        lab28:
            z->c = v_18;
            if (!b_is_verb) goto lab23;
            {
                int v_19 = z->c;
                z->bra = z->c;
                among_var = find_among(z, a_8, 4, 0);
                if (!among_var) { z->c = v_19; goto lab29; }
                z->ket = z->c;
                switch (among_var) {
                    case 1:
                        if (SIZE(z->p) < 5) { z->c = v_19; goto lab29; }
                        {
                            int ret = slice_from_s(z, 1, s_58);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 2:
                        if (SIZE(z->p) < 5) { z->c = v_19; goto lab29; }
                        {
                            int ret = slice_from_s(z, 1, s_59);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 3:
                        if (SIZE(z->p) < 5) { z->c = v_19; goto lab29; }
                        {
                            int ret = slice_from_s(z, 1, s_60);
                            if (ret < 0) return ret;
                        }
                        break;
                    case 4:
                        if (SIZE(z->p) < 5) { z->c = v_19; goto lab29; }
                        {
                            int ret = slice_from_s(z, 1, s_61);
                            if (ret < 0) return ret;
                        }
                        break;
                }
            lab29:
                ;
            }
            z->bra = z->c;
            if (z->c + 2 >= z->l || z->p[z->c + 2] != 1578) goto lab23;
            if (!find_among(z, a_9, 3, 0)) goto lab23;
            z->ket = z->c;
            if (SIZE(z->p) < 5) goto lab23;
            b_is_verb = 1;
            b_is_noun = 0;
            {
                int ret = slice_from_s(z, 3, s_62);
                if (ret < 0) return ret;
            }
        } while (0);
    lab23:
        z->c = v_15;
    }
    {
        int v_20 = z->c;
        z->lb = z->c; z->c = z->l;
        z->ket = z->c;
        if (z->c <= z->lb || z->p[z->c - 1] >> 5 != 49 || !((124 >> (z->p[z->c - 1] & 0x1f)) & 1)) goto lab31;
        z->c--;
        z->bra = z->c;
        {
            int ret = slice_from_s(z, 1, s_63);
            if (ret < 0) return ret;
        }
        z->c = z->lb;
    lab31:
        z->c = v_20;
    }
    {
        int v_21 = z->c;
        while (1) {
            int v_22 = z->c;
            do {
                int v_23 = z->c;
                z->bra = z->c;
                if (z->c >= z->l || z->p[z->c + 0] >> 5 != 49 || !((124 >> (z->p[z->c + 0] & 0x1f)) & 1)) goto lab34;
                among_var = find_among(z, a_2, 5, 0);
                if (!among_var) goto lab34;
                z->ket = z->c;
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
                break;
            lab34:
                z->c = v_23;
                if (z->c >= z->l) goto lab33;
                z->c++;
            } while (0);
            continue;
        lab33:
            z->c = v_22;
            break;
        }
        z->c = v_21;
    }
    return 1;
}

extern struct SN_env * arabic_create_env(void) {
    return SN_new_env(sizeof(struct SN_env));
}
