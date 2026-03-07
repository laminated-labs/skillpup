# Skillpup justfile

default:
    @just --list

install:
    corepack pnpm install

build:
    corepack pnpm run build

test:
    corepack pnpm test
