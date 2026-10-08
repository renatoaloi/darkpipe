# Contributing

darkpipe is the CLI. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/renatoaloi/darkpipe.git
cd darkpipe
npm install
npm test
```

Node 22 or newer. `ffmpeg` and `ffprobe` must be on `PATH` for the render tests. Tests that need them skip when the binary is missing.

## What a change may touch

Domain code imports ports. It does not open a database, call a vendor URL, run ffmpeg, or append the ledger. A new vendor is a new adapter, registered by name, selected in config. Do not hard-code a URL, a key, or a file path inside `src/domain/`.

## Secrets

Never commit a credential, a `.env`, a `darkpipe.config.json` from a real workspace, or an npm recovery code. `doctor` must keep reporting credential names only. A pull request that prints a secret value will not be merged.

Copy `darkpipe.config.example.json` if you need a local config. That file is gitignored once you name it `darkpipe.config.json`.

## Checks

`npm test` is the gate. The GitHub Actions workflow runs the same command on Node 24 with ffmpeg installed.
