// Optional gold-standard validator.
//
// This is NOT part of the Electron app -- it's a tiny standalone CLI that
// uses the exact same libraries Stash does (goimagehash, nfnt/resize,
// disintegration/imaging) to compute a phash straight from a montage PNG.
// shared/phash-core.js has already been cross-validated against these same
// libraries (see the README's "Fidelity notes"), so you shouldn't need this
// for day-to-day use -- it's here for anyone who wants to double-check a
// specific montage themselves, or re-verify after modifying phash-core.js.
//
// Usage:
//   go mod init phashref && go mod tidy
//   go run . montage.png
//
// Pair it with the app's "save montage as PNG" export (or screenshot the
// montage canvas) to get a matching PNG to feed in here.
package main

import (
	"fmt"
	"image"
	_ "image/png"
	"os"

	"github.com/corona10/goimagehash"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run . <montage.png>")
		os.Exit(1)
	}

	f, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer f.Close()

	img, _, err := image.Decode(f)
	if err != nil {
		panic(err)
	}

	hash, err := goimagehash.PerceptionHash(img)
	if err != nil {
		panic(err)
	}

	fmt.Printf("hex:   %016x\n", hash.GetHash())
	fmt.Printf("int64: %d\n", int64(hash.GetHash()))
}
