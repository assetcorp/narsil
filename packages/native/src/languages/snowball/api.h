/*
 * Copied from runtime/api.h by the Snowball compiler 3.1.1, with each symbol widened to a
 * UTF-16 code unit so that the stemmer reads the same units as the TypeScript stemmer.
 *
 * Snowball is BSD-3-Clause, copyright (c) 2001, Dr Martin Porter and contributors. The NOTICE file at the root
 * of the repository carries the licence. Source from https://github.com/snowballstem/snowball.git at
 * 6772636350acfd63797e8cd24ff86c70fd2df6fc, verified against https://github.com/snowballstem/snowball-data.git at
 * a0ec0d0a2839ec885878868de20fcb63209d92b0.
 *
 * packages/ts/snowball/build.ts writes this file, so regenerate it with that script.
 */

#ifndef SNOWBALL_API_H_INCLUDED
#define SNOWBALL_API_H_INCLUDED

typedef unsigned short symbol;

/* Or replace 'char' above with 'short' for 16 bit characters.

   More precisely, replace 'char' with whatever type guarantees the
   character width you need.
*/

struct SN_env {
    symbol * p;
    int c; int l; int lb; int bra; int ket;
    int af;
};

#ifdef __cplusplus
extern "C" {
#endif

extern struct SN_env * SN_new_env(int alloc_size);
extern void SN_delete_env(struct SN_env * z);

extern int SN_set_current(struct SN_env * z, int size, const symbol * s);

#ifdef __cplusplus
}
#endif

#endif
