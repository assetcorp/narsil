package pattern

import (
	"sync"

	"github.com/assetcorp/narsil/packages/go/engine/internal/text"
)

var singleFoldSourcesByFold = sync.OnceValue(func() map[rune][]rune {
	sources := map[rune][]rune{}
	folded := make([]rune, 0, 4)
	for codePoint := rune(0); codePoint <= lastCodePoint; codePoint++ {
		folded = text.AppendFoldedCodePoint(folded[:0], codePoint)
		if len(folded) == 1 && folded[0] != codePoint {
			sources[folded[0]] = append(sources[folded[0]], codePoint)
		}
	}
	return sources
})

func singleFoldSources(folded rune) []rune {
	return singleFoldSourcesByFold()[folded]
}

func isFoldTarget(codePoint rune) bool {
	return len(singleFoldSources(codePoint)) > 0
}

func appendFolded(destination []rune, codePoint rune) []rune {
	if codePoint >= 'A' && codePoint <= 'Z' {
		return append(destination, codePoint+('a'-'A'))
	}
	if codePoint >= 0 && codePoint < 0x80 {
		return append(destination, codePoint)
	}
	return text.AppendFoldedCodePoint(destination, codePoint)
}
