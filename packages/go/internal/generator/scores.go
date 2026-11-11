package main

func scoredHitMethods() string {
	return "\n" + `func (h Hit) MarshalJSON() ([]byte, error) {
	type plain Hit
	return json.Marshal(struct {
		plain
		Score any ` + "`json:\"score,omitempty\"`" + `
	}{plain: plain(h), Score: encodeHitScore(h.Score)})
}

func (h *Hit) UnmarshalJSON(data []byte) error {
	type plain Hit
	var decoded struct {
		plain
		Score json.RawMessage ` + "`json:\"score\"`" + `
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	score, err := decodeHitScore(decoded.Score)
	if err != nil {
		return err
	}
	decoded.plain.Score = score
	*h = Hit(decoded.plain)
	return nil
}
`
}
