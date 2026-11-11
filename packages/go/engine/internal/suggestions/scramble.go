package suggestions

import (
	"crypto/hmac"
	"crypto/sha256"
	"strconv"

	"github.com/assetcorp/narsil/packages/go/engine/internal/narsilerr"
)

type ScrambledID [ScrambledIDBytes]byte

type Scrambler struct {
	key         []byte
	Fingerprint [KeyFingerprintBytes]byte
}

func KeyOf(key []byte) ([]byte, error) {
	if len(key) < MinKeyBytes {
		return nil, narsilerr.New(narsilerr.CodeConfigInvalid,
			"The query suggestions key must hold at least "+strconv.Itoa(MinKeyBytes)+" bytes, and it holds "+
				strconv.Itoa(len(key)), map[string]any{"bytes": len(key)})
	}
	return append([]byte(nil), key...), nil
}

func NewScrambler(key []byte) *Scrambler {
	scrambler := &Scrambler{key: key}
	copy(scrambler.Fingerprint[:], scrambler.digest([]byte(KeyFingerprintLabel)))
	return scrambler
}

func (scrambler *Scrambler) digest(message []byte) []byte {
	mac := hmac.New(sha256.New, scrambler.key)
	mac.Write(message)
	return mac.Sum(nil)
}

func (scrambler *Scrambler) Scramble(person string) ScrambledID {
	var id ScrambledID
	copy(id[:], scrambler.digest([]byte(person)))
	return id
}
