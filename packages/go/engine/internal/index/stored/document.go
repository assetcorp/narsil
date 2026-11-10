package stored

type Document struct {
	ID           string
	Fields       map[string]any
	FieldLengths map[string]uint32
	ContentBytes int
}
