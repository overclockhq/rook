BINARY := rook
ADDR   := 127.0.0.1:7480

.PHONY: build run dev build-linux fmt vet clean

## build: compile the rook binary for this machine
build:
	go build -o $(BINARY) ./cmd/rook

## run: build and run (loopback only)
run: build
	./$(BINARY) --addr $(ADDR)

## dev: run straight from source
dev:
	go run ./cmd/rook --addr $(ADDR)

## build-linux: cross-compile a Linux amd64 binary for deployment
build-linux:
	GOOS=linux GOARCH=amd64 go build -o $(BINARY)-linux-amd64 ./cmd/rook

## fmt: format all Go sources
fmt:
	go fmt ./...

## vet: static checks
vet:
	go vet ./...

## clean: remove built binaries
clean:
	rm -f $(BINARY) $(BINARY)-linux-amd64
