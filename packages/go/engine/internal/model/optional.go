package model

import "encoding/json"

type Optional[T any] struct {
	value T
	set   bool
}

const jsonNull = "null"

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

func (o Optional[T]) MarshalJSON() ([]byte, error) {
	if !o.set {
		return []byte(jsonNull), nil
	}
	return json.Marshal(o.value)
}

func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	if string(data) == jsonNull {
		*o = Optional[T]{}
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*o = Optional[T]{value: value, set: true}
	return nil
}
