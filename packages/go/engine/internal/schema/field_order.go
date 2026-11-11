package schema

import "slices"

func (p *Parsed) declaresExactly(paths []string) bool {
	if len(paths) != len(p.fields) {
		return false
	}
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		_, declared := p.byPath[path]
		_, repeated := seen[path]
		if !declared || repeated {
			return false
		}
		seen[path] = struct{}{}
	}
	return true
}

func (p *Parsed) InFieldOrder(paths []string) *Parsed {
	if !p.declaresExactly(paths) {
		return p
	}
	ordered := *p
	ordered.order = slices.Clone(paths)
	return &ordered
}

func (p *Parsed) FieldOrder() []string {
	return slices.Clone(p.order)
}
