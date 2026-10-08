# darkpipe command reference

Every command prints English text. With `--json` every command prints one JSON document
on stdout (`ok` is true, or `ok: false` with `error`) and sends progress to stderr.
File results carry absolute paths. No command serves case media over HTTP.

`darkpipe costs --json` is the one exception to the envelope: it prints a bare JSON
array of ledger events.

## Global options

| Option | Meaning |
|---|---|
| `--json` | one JSON document on stdout; progress on stderr |
| `--dry-run` | the default for spend and upload commands |
| `--execute` | spend credit or upload; required to leave the dry run |
| `--config <path>` | use another config file (default `./darkpipe.config.json`, or `DARKPIPE_CONFIG`) |
| `--foreground` | run a long command in this process instead of forking a job |

## doctor

| Command | What it does |
|---|---|
| `darkpipe doctor` | reports the adapter of every port, credential presence, the render binaries and the store; exits non-zero when the config file carries a secret-shaped value |
| `darkpipe doctor --json` | the same document |

Credential values are never printed — only `present` or `missing`.

## config

| Command | What it does |
|---|---|
| `darkpipe config` | prints the active config |
| `darkpipe config get <key>` | prints one value, e.g. `media.adapter` |
| `darkpipe config set <key> <value>` | writes one value; refuses anything credential-shaped |
| `darkpipe config defaults` | prints the built-in configuration |

## case

| Command | What it does |
|---|---|
| `darkpipe case new <case_id> "<English title>" [--vertical <v>] [--no-research]` | opens a case |
| `darkpipe case list [--state <state>]` | lists cases in queue order |
| `darkpipe case show <case_id>` | shows one case, its store row and the files in its folder (absolute paths) |
| `darkpipe case status <case_id> [--set <state>] [--notes "<text>"]` | reads or sets the state |

The id must match `case_NNNN_slug` (four digits, underscore, lowercase slug) and the
vertical must be one of `dark_history`, `space_aviation`, `engineering`, `pilot`,
`pilot_mix`. Anything else is refused and creates neither a folder nor a store row.

Opening a case creates exactly:

```
cases/<case_id>/
├── 01_script.md            # from templates/, or the researched guide script
├── 02_narration_script.md  # from templates/
├── 07_meta.yaml            # from templates/
├── 02_narration_parts/     # one audio file per narration block
└── 04_shots/v0/
```

`03_shots.json` is deliberately NOT created at open: the shot plan is born later, from
the recorded narration (`plan propose`). The case enters the queue last
(`priority` = current maximum + 1) in state `backlog`.

By default the open also calls the text port to research the case and writes the guide
script into `01_script.md` and the case style card into `05_estilo.json`, recording one
cost event. `--no-research` skips that and warns that the case was created without
context; a failed research keeps the case with its template files and can be run again.

## compete

| Command | What it does |
|---|---|
| `darkpipe compete "<subject>"` | measures the competition for a candidate case before it is opened (terminal only, not a screen) |

## narrate and voice

| Command | What it does |
|---|---|
| `darkpipe narrate <case_id> [--execute] [--block <n>]` | writes the narration audio into `02_narration_parts/` |
| `darkpipe voice test "<text>" [--execute] [--out <file>]` | synthesizes a short sample and writes no case narration |

## plan

The order that does not discard written work is **propose → apply → prompts**.

| Command | What it does |
|---|---|
| `darkpipe plan propose <case_id>` | proposes cuts from the recorded narration (ruler: 8.5s per visual, 4s floor, 12s ceiling, one clip per three stills) into `03_shots_proposto.json` |
| `darkpipe plan apply <case_id>` | moves the proposal into the live plan `03_shots.json` |
| `darkpipe plan anchor <case_id>` | locks the plan to the current narration and syncs the shot rows through the store port — only when the case is registered |
| `darkpipe plan check <case_id>` | lists orphan shots, narration stretches with no visual, suspect shots and cuts under the 4 second floor, and writes `03_shots_revisar.md` |

A proposal stays pending while the proposed cuts differ from the live map in shot
number, block, span or kind — a proposal that only turns stills into clips is still
pending.

## prompts

| Command | What it does |
|---|---|
| `darkpipe prompts write <case_id> [--execute] [--block <n>]` | writes prompts for the shots that still need one (`[A DEFINIR]`), on the live plan only |

Hand-written prompts are preserved. When a proposal is waiting, the command says so and
still shows the live plan's prompts.

## timeline

| Command | What it does |
|---|---|
| `darkpipe timeline show <case_id>` | prints the cut map |
| `darkpipe timeline span <case_id> <shot> <seconds>` | sets the on-screen time of one cut |
| `darkpipe timeline boundary <case_id> <shot> <delta>` | moves one boundary and its neighbour together |
| `darkpipe timeline slide <case_id> <shot> <delta>` | moves a cut window |
| `darkpipe timeline snap <case_id> <shot>` | snaps a cut to the narration sentence change |
| `darkpipe timeline include <case_id> <shot>` | brings a removed cut back |
| `darkpipe timeline remove <case_id> <shot>` | takes a cut out of the map |
| `darkpipe timeline swap <case_id> <shot_a> <shot_b>` | exchanges two cuts |
| `darkpipe timeline gaps <case_id> [--default <s> \| --opening <s> \| --reset]` | sets the pauses between blocks |
| `darkpipe timeline endcard <case_id> [--seconds <s>]` | sets the closing card |
| `darkpipe timeline validate <case_id> [--blocks <n[,m]>]` | reports cut, retime, gap and overlap problems |
| `darkpipe timeline undo <case_id>` | restores the previous map and keeps the replaced one as a backup |

Every change writes a backup first. A fixed-length clip retimed between 0.5x and 2x is
the channel design, not a defect; a step that moves a cut toward that range is always
accepted.

## still

| Command | What it does |
|---|---|
| `darkpipe still import <case_id> <shot> <file>` | fits a real photo to 16:9 on one cut (`origin: real`) |
| `darkpipe still revert <case_id> <shot>` | puts the generated still back |

## generate

| Command | What it does |
|---|---|
| `darkpipe generate <case_id> [--execute] [--block <n>] [--no-check]` | generates the stills and clips of the plan |

Dry run by default. An unanchored plan is refused, naming `darkpipe plan anchor` and
`darkpipe plan check`; `--no-check` overrides that. The `[A DEFINIR]` gate only looks at
the shots inside the requested `--block` scope. Each attempt appends exactly one ledger
event (see below).

## render

| Command | What it does |
|---|---|
| `darkpipe render <case_id> [--blocks <n[,m]>] [--no-backup] [--check]` | validates the map and assembles the video |

Validation stops assembly before the render when it finds a cut under 4 seconds, a clip
outside 0.5x–2x, a missing still or clip, a block gap over 1.5 seconds, or overlapping
spans — and the previous final video keeps its bytes. The previous final video is kept
under a timestamped name and the report prints the checksum of both files.

`--blocks` writes a chapter preview (`<case>_blocks_02-02.mp4`) on the same time ruler
as the full video and never touches the final file. Missing art outside the requested
chapters is a warning; a problem inside the scope blocks.

## style, shorts, posts

| Command | What it does |
|---|---|
| `darkpipe style <case_id> [--set <combination>]` | shows or sets the case style card (`05_estilo.json`) |
| `darkpipe shorts <case_id>` | plans the shorts for a case |
| `darkpipe posts <case_id>` | writes the community posts for a case |

## costs

| Command | What it does |
|---|---|
| `darkpipe costs [--json] [--case <id>] [--kind <kind>]` | prints the ledger events, newest last |

Each event records `at`, `case`, `shot`, `kind`, `provider`, `model`, `usd`, `tokens_in`,
`tokens_out`, `latency_ms`, `job_id` and `status`. The CLI never totals or groups them —
a frontend consolidates. `--case` and `--kind` only drop events.

## jobs

| Command | What it does |
|---|---|
| `darkpipe jobs` | lists running and finished long runs |
| `darkpipe jobs cancel <id>` | stops a running job by id |

Cancelling stops the run and never deletes case files already written. There is no
daemon: records live in `.darkpipe/jobs.json`.

## publish

| Command | What it does |
|---|---|
| `darkpipe publish <case_id>` | builds the YouTube pack and writes it into the case folder (dry run) |
| `darkpipe publish <case_id> --execute` | uploads the video and the pack through the publisher port |

The pack is derived from the case files: title up to 100 characters, description up to
5000, tags within 500 characters including commas (overflow tags are dropped and named),
chapters starting at `00:00` (omitted when fewer than three would remain or any chapter
is under 10 seconds), language `en`, thumbnail 16:9 at least 640px wide and at most 2MB.
A violent word at the start of the title or in the first 2 seconds of narration is
reported and blocks `--execute`.

A successful upload stores the video id in the pack and does not change the case status —
the operator sets that with `darkpipe case status`.

## Out of scope

- **Agenda**: `agenda.sqlite`, calendar and seeding have no command here.
- **Cost aggregation**: the CLI emits events; totals, per-case and per-kind rolls are the
  frontend's job.
- **An HTTP media server**: media preview is an absolute file path in JSON.
- **The SPA**: it is not shipped and is not the contract.
- **Bundled ffmpeg**: `ffmpeg` and `ffprobe` must be on PATH; `doctor` names a missing binary.

## Legacy

This repository is the CLI. It does not ship a panel, a calendar, or the older
Python scripts. Those stay in the operator's private workspace.
