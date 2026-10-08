# darkpipe

[![ci](https://github.com/renatoaloi/darkpipe/actions/workflows/ci.yml/badge.svg)](https://github.com/renatoaloi/darkpipe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/darkpipe)](https://www.npmjs.com/package/darkpipe)
[![license](https://img.shields.io/github/license/renatoaloi/darkpipe)](./LICENSE)
[![node](https://img.shields.io/node/v/darkpipe)](https://nodejs.org)

One English command for a faceless dark-channel pipeline: open a case, plan the cuts, write the prompts, generate the art, assemble the video, and publish it.

```bash
npm install -g darkpipe
darkpipe doctor
darkpipe case new case_0001_example "An unresolved case" --vertical dark_history --no-research
```

Spend and upload stay dry-run until you pass `--execute`.

## Requirements

- Node 22 or newer
- `ffmpeg` and `ffprobe` on `PATH` (they are not bundled)

## Config and secrets

Adapter names and non-secret settings go in `darkpipe.config.json`. Start from [`darkpipe.config.example.json`](darkpipe.config.example.json).

Secrets are environment variables only:

- `RUNWARE_API_KEY`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

`darkpipe doctor` reports each name as `present` or `missing`. It never prints a value, and it fails if the config file contains something that looks like a key.

## Ports

The domain code imports ports. It does not open a database, call a vendor, run ffmpeg, or append the ledger. Swapping an implementation is a config change.

| Port | Default adapter | Swap means |
|---|---|---|
| store | SQLite file `darkpipe.sqlite` | another store adapter |
| files | `cases/<id>/` on disk | another files adapter |
| media, speech, text | Runware | another vendor adapter (`fake` for offline runs) |
| render | `ffmpeg` / `ffprobe` on `PATH` | another renderer adapter |
| ledger | append-only JSON lines | another ledger adapter |
| publisher | YouTube Data API v3 | another publisher adapter |

`darkpipe doctor --json` names the active adapter of every port.

## Costs

`darkpipe costs --json` prints a bare array of events. There is no total. A frontend consolidates.

## Out of scope

Agenda and calendar, cost aggregation, an HTTP media server, and bundling ffmpeg.

Command reference: [docs/commands.md](docs/commands.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Renato Aloi
