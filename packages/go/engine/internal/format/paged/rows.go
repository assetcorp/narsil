package paged

type Rows struct {
	Documents       []uint32
	Frequencies     []uint16
	Fields          []uint16
	PositionOffsets []uint32
	Positions       []uint32
}

func (rows Rows) heldBytes() int64 {
	return int64(len(rows.Documents)*4 + len(rows.Frequencies)*2 + len(rows.Fields)*2 + len(rows.PositionOffsets)*4 +
		len(rows.Positions)*4)
}

func (reader *Reader) decodedRows(token int) (Rows, error) {
	list, err := reader.PostingList(token)
	if err != nil {
		return Rows{}, err
	}
	count := list.Documents.Len()
	rows := Rows{Documents: make([]uint32, count), Frequencies: make([]uint16, count), Fields: make([]uint16, count)}
	for row := range count {
		rows.Documents[row] = list.Documents.At(row)
		rows.Frequencies[row] = list.Frequencies.At(row)
		rows.Fields[row] = list.Fields.At(row)
	}
	positions, tracks, err := reader.Positions(token)
	if err != nil || !tracks {
		return rows, err
	}
	rows.PositionOffsets = make([]uint32, count+1)
	for row := 0; row <= count; row++ {
		rows.PositionOffsets[row] = positions.Offsets.At(row) - positions.first
	}
	rows.Positions = make([]uint32, positions.Values.Len())
	for at := range rows.Positions {
		rows.Positions[at] = positions.Values.At(at)
	}
	return rows, nil
}

func (reader *Reader) Rows(token int) (Rows, error) {
	file := reader.cached
	if file != nil {
		if held, found := file.cache.Get(file.number, CachedList, int64(token)); found {
			if rows, isRows := held.(Rows); isRows {
				return rows, nil
			}
		}
	}
	rows, err := reader.decodedRows(token)
	if err != nil {
		return Rows{}, err
	}
	if file != nil && !file.closed.Load() {
		file.cache.Put(file.number, CachedList, int64(token), rows, rows.heldBytes())
	}
	return rows, nil
}
