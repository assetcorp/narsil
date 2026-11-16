package analysis

func (p *Pass) Borrow(lender *Pass) {
	if p == nil || lender == nil || p.remembered == nil || lender.remembered == nil || lender.analyzer != p.analyzer ||
		lender.remembered == p.remembered {
		return
	}
	held := p.remembered
	held.mu.Lock()
	defer held.mu.Unlock()
	if _, lent := held.lent[lender.remembered]; lent {
		return
	}
	if held.lent == nil {
		held.lent = map[*rememberedTokens]struct{}{}
	}
	held.lent[lender.remembered] = struct{}{}
	held.lenders = append(held.lenders, lender.remembered)
}

func (p *Pass) AbsorbBorrowed() {
	if p == nil || p.remembered == nil {
		return
	}
	held := p.remembered
	held.mu.Lock()
	lenders := held.lenders
	held.mu.Unlock()
	if len(lenders) == 0 {
		return
	}
	copied := map[string]rememberedTokenization{}
	for _, lender := range lenders {
		lender.mu.Lock()
		for source, tokenization := range lender.entries {
			if _, found := copied[source]; !found {
				copied[source] = tokenization
			}
		}
		lender.mu.Unlock()
	}
	held.mu.Lock()
	defer held.mu.Unlock()
	for source, tokenization := range copied {
		if _, found := held.entries[source]; !found {
			held.entries[source] = tokenization
		}
	}
	for _, lender := range lenders {
		delete(held.lent, lender)
	}
	held.lenders = append([]*rememberedTokens(nil), held.lenders[len(lenders):]...)
}
