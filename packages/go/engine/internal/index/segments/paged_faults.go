package segments

import (
	"errors"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/core"
	"github.com/assetcorp/narsil/packages/go/engine/internal/vector"
)

func (p *Paged) sectionNameAt(offset uint64) string {
	if name, held := p.sectionNames[offset]; held {
		return name
	}
	return strconv.FormatUint(offset, 10)
}

func (p *Paged) pageFailure(err error) error {
	var fault *core.PageError
	if !errors.As(err, &fault) {
		return err
	}
	return vector.PageFailure(fault, p.path, p.sectionNameAt(fault.Fault.Section))
}

func (s *State) failure(err error) error {
	if err == nil || s.pageFailure == nil {
		return err
	}
	return s.pageFailure(err)
}
