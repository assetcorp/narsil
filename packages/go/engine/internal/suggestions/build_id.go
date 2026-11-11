package suggestions

import (
	"crypto/rand"
	"encoding/hex"
)

func NewBuildID() string {
	var random [16]byte
	_, _ = rand.Read(random[:])
	random[6] = (random[6] & 0x0f) | 0x40
	random[8] = (random[8] & 0x3f) | 0x80
	text := hex.EncodeToString(random[:])
	return text[0:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:]
}
