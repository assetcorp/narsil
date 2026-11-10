package fields

import "github.com/assetcorp/narsil/packages/go/engine/internal/core"

type Boolean struct {
	limits     Limits
	trueBits   array[uint32]
	falseBits  array[uint32]
	trueCount  uint64
	falseCount uint64
	present    presence
}

func NewBoolean(limits Limits) (*Boolean, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	words := 2 * bitsetWords(limits.MaxOrdinals)
	index := &Boolean{
		limits:    limits,
		trueBits:  newArray[uint32]("boolean true bitset", words),
		falseBits: newArray[uint32]("boolean false bitset", words),
		present:   newPresence("boolean present bitset", limits.MaxOrdinals),
	}
	if err := index.trueBits.reserveExactly(booleanInitialWords); err != nil {
		return nil, err
	}
	if err := index.falseBits.reserveExactly(booleanInitialWords); err != nil {
		index.trueBits.release()
		return nil, err
	}
	return index, nil
}

func (b *Boolean) reserveFor(ordinal uint32) error {
	if err := b.limits.checkOrdinal(ordinal); err != nil {
		return err
	}
	words := uint64(ordinal>>wordShift) + 1
	held := min(b.trueBits.capacity, b.falseBits.capacity)
	if words <= held {
		return nil
	}
	target := max(words, held*2)
	if err := b.trueBits.reserveExactly(target); err != nil {
		return err
	}
	return b.falseBits.reserveExactly(target)
}

func (b *Boolean) Insert(ordinal uint32, value bool) error {
	if err := b.reserveFor(ordinal); err != nil {
		return err
	}
	b.insert(ordinal, value)
	return nil
}

func (b *Boolean) insert(ordinal uint32, value bool) {
	bits := b.falseBits.all()
	if value {
		bits = b.trueBits.all()
	}
	if hasBit(bits, ordinal) {
		return
	}
	b.present.invalidate()
	setBit(bits, ordinal)
	if value {
		b.trueCount++
	} else {
		b.falseCount++
	}
}

func (b *Boolean) Remove(ordinal uint32, value bool) {
	bits := b.falseBits.all()
	if value {
		bits = b.trueBits.all()
	}
	if !hasBit(bits, ordinal) {
		return
	}
	b.present.invalidate()
	clearBit(bits, ordinal)
	if value {
		b.trueCount--
	} else {
		b.falseCount--
	}
}

func (b *Boolean) Settle(capacity uint32) error {
	index := b.Index()
	return b.present.rebuild(capacity, func(bits []uint32) {
		for at := range min(len(bits), len(index.TrueBits)) {
			bits[at] = index.TrueBits[at] | index.FalseBits[at]
		}
	})
}

func (b *Boolean) Index() *core.BooleanIndex {
	words := min(b.trueBits.capacity, b.falseBits.capacity)
	return &core.BooleanIndex{TrueBits: b.trueBits.prefix(words), FalseBits: b.falseBits.prefix(words)}
}

func (b *Boolean) Present() []uint32 {
	return b.present.view()
}

func (b *Boolean) Count() uint64 {
	return b.trueCount + b.falseCount
}

func (b *Boolean) RegionBytes() uint64 {
	return b.trueBits.bytes() + b.falseBits.bytes() + b.present.bytes()
}

func (b *Boolean) Release() {
	b.trueBits.release()
	b.falseBits.release()
	b.present.release()
	b.trueCount, b.falseCount = 0, 0
}
