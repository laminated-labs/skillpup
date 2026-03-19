# Skillpup justfile

default:
    @just --list

install:
    pnpm install

build:
    pnpm run build

test:
    pnpm test

skills:
    pnpm exec tsx src/cli.ts fetch

docs:
    pnpm dlx docpup@0.1.9 generate

context:
    just skills
    just docs
