module phashref

go 1.25.0

// Pinned to exactly what stashapp/stash's go.mod uses, so this reference
// answers "what would Stash compute", not "what does the latest library do".
require (
	github.com/corona10/goimagehash v1.1.0
	github.com/nfnt/resize v0.0.0-20180221191011-83c6a9932646 // indirect
	golang.org/x/image v0.41.0
)
