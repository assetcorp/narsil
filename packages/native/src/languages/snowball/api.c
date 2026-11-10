/*
 * Copied from runtime/api.c by the Snowball compiler 3.1.1, with each symbol widened to a
 * UTF-16 code unit so that the stemmer reads the same units as the TypeScript stemmer.
 *
 * Each malloc and realloc call goes through core_allocate and core_reallocate in src/allocation.h, so that the
 * allocation-failure test in packages/native/test can refuse it.
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

#include "../../allocation.h"


#include <stdlib.h> /* for malloc, free */
#include <string.h> /* for memset */
#include "snowball_runtime.h"

extern struct SN_env * SN_new_env(int alloc_size)
{
    struct SN_env * z = (struct SN_env *) core_allocate(alloc_size);
    if (z == NULL) return NULL;
    /* This memset() will initialise z->p to all-bits-zero which (at least
     * theoretically) may not be the NULL pointer representation, but that's OK
     * as immediately afterwards we assign to z->p.
     */
    memset(z, 0, alloc_size);
    z->p = create_s();
    if (z->p == NULL) {
        SN_delete_env(z);
        return NULL;
    }
    return z;
}

extern void SN_delete_env(struct SN_env * z)
{
    if (z == NULL) return;
    if (z->p) lose_s(z->p);
    free(z);
}

extern int SN_set_current(struct SN_env * z, int size, const symbol * s)
{
    int err = replace_s(z, 0, z->l, size, s);
    z->c = 0;
    return err;
}
