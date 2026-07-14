// Gold-standard reference: computes the phash of one or more montage images
// using the exact same Go libraries (and versions, see go.mod) that Stash
// uses, so shared/phash-core.js can be checked against the real thing rather
// than against its own understanding of it.
//
// Not part of the shipped app. Used to (re)generate test/fixtures/expected.json:
//
//	node test/fixtures/generate.js /tmp/fixtures
//	cd tools/go-reference && go run . /tmp/fixtures/*.png > ../../test/fixtures/expected.json
//
// or to check a single collage exported from the app's "Save collage as
// PNG" button:
//
//	go run . montage.png
//
// Output is a JSON object keyed by the file's base name without extension.
package main

import (
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/corona10/goimagehash"
	_ "golang.org/x/image/bmp"
)

type result struct {
	Hex string `json:"hex"`
	// As a string: JSON numbers beyond 2^53 lose precision in JavaScript.
	Int64 string `json:"int64"`
}

func hashFile(path string) (result, error) {
	f, err := os.Open(path)
	if err != nil {
		return result{}, err
	}
	defer f.Close()

	img, _, err := image.Decode(f)
	if err != nil {
		return result{}, fmt.Errorf("decoding %s: %w", path, err)
	}

	hash, err := goimagehash.PerceptionHash(img)
	if err != nil {
		return result{}, err
	}
	return result{Hex: fmt.Sprintf("%016x", hash.GetHash()), Int64: strconv.FormatInt(int64(hash.GetHash()), 10)}, nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run . <image.png> [more.png ...]")
		os.Exit(1)
	}

	out := map[string]result{}
	for _, path := range os.Args[1:] {
		r, err := hashFile(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		out[name] = r
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}
