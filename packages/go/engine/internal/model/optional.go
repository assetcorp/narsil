package model

type Optional[T any] struct {
	value T
	set   bool
}

func Some[T any](value T) Optional[T] {
	return Optional[T]{value: value, set: true}
}

func (o Optional[T]) Get() (T, bool) {
	return o.value, o.set
}

func (o Optional[T]) IsSet() bool {
	return o.set
}

func (o Optional[T]) Or(fallback T) T {
	if o.set {
		return o.value
	}
	return fallback
}
