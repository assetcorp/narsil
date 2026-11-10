package text

import (
	"strconv"
	"strings"
	"sync"
)

const (
	FoldUnicodeVersion = "17.0.0"
	FoldEntryCount     = 1585
	maxFoldExpansion   = 3
	packedNumberBase   = 36
)

type foldRun struct {
	first  rune
	count  int
	step   rune
	offset rune
}

var singleFoldRuns = [...]foldRun{
	{0x41, 26, 1, 32}, {0xb5, 1, 1, 775}, {0xc0, 23, 1, 32}, {0xd8, 7, 1, 32}, {0x100, 24, 2, 1}, {0x132, 3, 2, 1},
	{0x139, 8, 2, 1}, {0x14a, 23, 2, 1}, {0x178, 1, 1, -121}, {0x179, 3, 2, 1}, {0x17f, 1, 1, -268}, {0x181, 1, 1, 210},
	{0x182, 2, 2, 1}, {0x186, 1, 1, 206}, {0x187, 1, 1, 1}, {0x189, 2, 1, 205}, {0x18b, 1, 1, 1}, {0x18e, 1, 1, 79},
	{0x18f, 1, 1, 202}, {0x190, 1, 1, 203}, {0x191, 1, 1, 1}, {0x193, 1, 1, 205}, {0x194, 1, 1, 207}, {0x196, 1, 1, 211},
	{0x197, 1, 1, 209}, {0x198, 1, 1, 1}, {0x19c, 1, 1, 211}, {0x19d, 1, 1, 213}, {0x19f, 1, 1, 214}, {0x1a0, 3, 2, 1},
	{0x1a6, 1, 1, 218}, {0x1a7, 1, 1, 1}, {0x1a9, 1, 1, 218}, {0x1ac, 1, 1, 1}, {0x1ae, 1, 1, 218}, {0x1af, 1, 1, 1},
	{0x1b1, 2, 1, 217}, {0x1b3, 2, 2, 1}, {0x1b7, 1, 1, 219}, {0x1b8, 1, 1, 1}, {0x1bc, 1, 1, 1}, {0x1c4, 1, 1, 2},
	{0x1c5, 1, 1, 1}, {0x1c7, 1, 1, 2}, {0x1c8, 1, 1, 1}, {0x1ca, 1, 1, 2}, {0x1cb, 9, 2, 1}, {0x1de, 9, 2, 1},
	{0x1f1, 1, 1, 2}, {0x1f2, 2, 2, 1}, {0x1f6, 1, 1, -97}, {0x1f7, 1, 1, -56}, {0x1f8, 20, 2, 1}, {0x220, 1, 1, -130},
	{0x222, 9, 2, 1}, {0x23a, 1, 1, 10795}, {0x23b, 1, 1, 1}, {0x23d, 1, 1, -163}, {0x23e, 1, 1, 10792}, {0x241, 1, 1, 1},
	{0x243, 1, 1, -195}, {0x244, 1, 1, 69}, {0x245, 1, 1, 71}, {0x246, 5, 2, 1}, {0x345, 1, 1, 116}, {0x370, 2, 2, 1},
	{0x376, 1, 1, 1}, {0x37f, 1, 1, 116}, {0x386, 1, 1, 38}, {0x388, 3, 1, 37}, {0x38c, 1, 1, 64}, {0x38e, 2, 1, 63},
	{0x391, 17, 1, 32}, {0x3a3, 9, 1, 32}, {0x3c2, 1, 1, 1}, {0x3cf, 1, 1, 8}, {0x3d0, 1, 1, -30}, {0x3d1, 1, 1, -25},
	{0x3d5, 1, 1, -15}, {0x3d6, 1, 1, -22}, {0x3d8, 12, 2, 1}, {0x3f0, 1, 1, -54}, {0x3f1, 1, 1, -48}, {0x3f4, 1, 1, -60},
	{0x3f5, 1, 1, -64}, {0x3f7, 1, 1, 1}, {0x3f9, 1, 1, -7}, {0x3fa, 1, 1, 1}, {0x3fd, 3, 1, -130}, {0x400, 16, 1, 80},
	{0x410, 32, 1, 32}, {0x460, 17, 2, 1}, {0x48a, 27, 2, 1}, {0x4c0, 1, 1, 15}, {0x4c1, 7, 2, 1}, {0x4d0, 48, 2, 1},
	{0x531, 38, 1, 48}, {0x10a0, 38, 1, 7264}, {0x10c7, 1, 1, 7264}, {0x10cd, 1, 1, 7264}, {0x13f8, 6, 1, -8},
	{0x1c80, 1, 1, -6222}, {0x1c81, 1, 1, -6221}, {0x1c82, 1, 1, -6212}, {0x1c83, 2, 1, -6210}, {0x1c85, 1, 1, -6211},
	{0x1c86, 1, 1, -6204}, {0x1c87, 1, 1, -6180}, {0x1c88, 1, 1, 35267}, {0x1c89, 1, 1, 1}, {0x1c90, 43, 1, -3008},
	{0x1cbd, 3, 1, -3008}, {0x1e00, 75, 2, 1}, {0x1e9b, 1, 1, -58}, {0x1ea0, 48, 2, 1}, {0x1f08, 8, 1, -8},
	{0x1f18, 6, 1, -8}, {0x1f28, 8, 1, -8}, {0x1f38, 8, 1, -8}, {0x1f48, 6, 1, -8}, {0x1f59, 4, 2, -8}, {0x1f68, 8, 1, -8},
	{0x1fb8, 2, 1, -8}, {0x1fba, 2, 1, -74}, {0x1fbe, 1, 1, -7173}, {0x1fc8, 4, 1, -86}, {0x1fd8, 2, 1, -8},
	{0x1fda, 2, 1, -100}, {0x1fe8, 2, 1, -8}, {0x1fea, 2, 1, -112}, {0x1fec, 1, 1, -7}, {0x1ff8, 2, 1, -128},
	{0x1ffa, 2, 1, -126}, {0x2126, 1, 1, -7517}, {0x212a, 1, 1, -8383}, {0x212b, 1, 1, -8262}, {0x2132, 1, 1, 28},
	{0x2160, 16, 1, 16}, {0x2183, 1, 1, 1}, {0x24b6, 26, 1, 26}, {0x2c00, 48, 1, 48}, {0x2c60, 1, 1, 1},
	{0x2c62, 1, 1, -10743}, {0x2c63, 1, 1, -3814}, {0x2c64, 1, 1, -10727}, {0x2c67, 3, 2, 1}, {0x2c6d, 1, 1, -10780},
	{0x2c6e, 1, 1, -10749}, {0x2c6f, 1, 1, -10783}, {0x2c70, 1, 1, -10782}, {0x2c72, 1, 1, 1}, {0x2c75, 1, 1, 1},
	{0x2c7e, 2, 1, -10815}, {0x2c80, 50, 2, 1}, {0x2ceb, 2, 2, 1}, {0x2cf2, 1, 1, 1}, {0xa640, 23, 2, 1},
	{0xa680, 14, 2, 1}, {0xa722, 7, 2, 1}, {0xa732, 31, 2, 1}, {0xa779, 2, 2, 1}, {0xa77d, 1, 1, -35332},
	{0xa77e, 5, 2, 1}, {0xa78b, 1, 1, 1}, {0xa78d, 1, 1, -42280}, {0xa790, 2, 2, 1}, {0xa796, 10, 2, 1},
	{0xa7aa, 1, 1, -42308}, {0xa7ab, 1, 1, -42319}, {0xa7ac, 1, 1, -42315}, {0xa7ad, 1, 1, -42305}, {0xa7ae, 1, 1, -42308},
	{0xa7b0, 1, 1, -42258}, {0xa7b1, 1, 1, -42282}, {0xa7b2, 1, 1, -42261}, {0xa7b3, 1, 1, 928}, {0xa7b4, 8, 2, 1},
	{0xa7c4, 1, 1, -48}, {0xa7c5, 1, 1, -42307}, {0xa7c6, 1, 1, -35384}, {0xa7c7, 2, 2, 1}, {0xa7cb, 1, 1, -42343},
	{0xa7cc, 8, 2, 1}, {0xa7dc, 1, 1, -42561}, {0xa7f5, 1, 1, 1}, {0xab70, 80, 1, -38864}, {0xff21, 26, 1, 32},
	{0x10400, 40, 1, 40}, {0x104b0, 36, 1, 40}, {0x10570, 11, 1, 39}, {0x1057c, 15, 1, 39}, {0x1058c, 7, 1, 39},
	{0x10594, 2, 1, 39}, {0x10c80, 51, 1, 64}, {0x10d50, 22, 1, 32}, {0x118a0, 32, 1, 32}, {0x16e40, 32, 1, 32},
	{0x16ea0, 25, 1, 27}, {0x1e900, 34, 1, 34},
}

const packedMultiFolds = "67,37,37;29,2x,lj;p,jg,32;4n,2y,lo;bk,qh,lk,ld;w,qt,lk,ld;d3,12d,136;4y7,2w,mp;1,38,lk;1,3b,lm;1,3d,lm;1,2p,ji;4,37,37;4y,qt,lv;2,qt,lv,lc;2,qt,lv,ld;2,qt,lv,n6;16,64g,qh;1,64h,qh;1,64i,qh;1,64j,qh;1,64k,qh;1,64l,qh;1,64m,qh;1,64n,qh;1,64g,qh;1,64h,qh;1,64i,qh;1,64j,qh;1,64k,qh;1,64l,qh;1,64m,qh;1,64n,qh;1,65c,qh;1,65d,qh;1,65e,qh;1,65f,qh;1,65g,qh;1,65h,qh;1,65i,qh;1,65j,qh;1,65c,qh;1,65d,qh;1,65e,qh;1,65f,qh;1,65g,qh;1,65h,qh;1,65i,qh;1,65j,qh;1,674,qh;1,675,qh;1,676,qh;1,677,qh;1,678,qh;1,679,qh;1,67a,qh;1,67b,qh;1,674,qh;1,675,qh;1,676,qh;1,677,qh;1,678,qh;1,679,qh;1,67a,qh;1,67b,qh;3,67k,qh;1,q9,qh;1,q4,qh;2,q9,n6;1,q9,n6,qh;5,q9,qh;6,67o,qh;1,qf,qh;1,q6,qh;2,qf,n6;1,qf,n6,qh;5,qf,qh;6,qh,lk,lc;1,qh,lk,ld;3,qh,n6;1,qh,lk,n6;b,qt,lk,lc;1,qt,lk,ld;1,qp,lv;2,qt,n6;1,qt,lk,n6;b,67w,qh;1,qx,qh;1,r2,qh;2,qx,n6;1,qx,n6,qh;5,qx,qh;179g,2u,2u;1,2u,2x;1,2u,30;1,2u,2u,2x;1,2u,2u,30;1,37,38;1,37,38;d,12s,12u;1,12s,12d;1,12s,12j;1,132,12u;1,12s,12l;"

type foldExpansion struct {
	codePoints [maxFoldExpansion]rune
	count      int
}

type foldTables struct {
	single map[rune]rune
	multi  map[rune]foldExpansion
}

var loadFoldTables = sync.OnceValue(buildFoldTables)

func parsePackedNumber(packed string) rune {
	value, err := strconv.ParseInt(packed, packedNumberBase, 32)
	if err != nil {
		return 0
	}
	return rune(value)
}

func buildFoldTables() *foldTables {
	tables := &foldTables{single: map[rune]rune{}, multi: map[rune]foldExpansion{}}
	for _, run := range singleFoldRuns {
		for index := range run.count {
			source := run.first + rune(index)*run.step
			tables.single[source] = source + run.offset
		}
	}
	source := rune(0)
	for entry := range strings.SplitSeq(packedMultiFolds, ";") {
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ",")
		source += parsePackedNumber(parts[0])
		var expansion foldExpansion
		for _, part := range parts[1:] {
			if expansion.count == maxFoldExpansion {
				break
			}
			expansion.codePoints[expansion.count] = parsePackedNumber(part)
			expansion.count++
		}
		tables.multi[source] = expansion
	}
	return tables
}
