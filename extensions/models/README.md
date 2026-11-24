# @sntxrr/apple-container

Manage Linux containers on a Mac with [Apple's `container`
CLI](https://github.com/apple/container).

## Requirements

- Apple silicon and macOS 26 or later
- Apple's CLI on the machine running swamp: `brew install container`

Written against CLI 1.7.1.

## Usage

```bash
swamp extension pull @sntxrr/apple-container
swamp model create @sntxrr/apple-container mac

swamp model method run mac systemStart
swamp model method run mac ensure \
  --input name=web \
  --input image=docker.io/library/nginx:1.29-alpine \
  --input 'ports:json=["127.0.0.1:8080:80"]'
swamp model method run mac sync
```

Under launchd or cron, set the CLI's full path:

```bash
swamp model create @sntxrr/apple-container mac \
  --global-arg binary=/opt/homebrew/bin/container
```

## Methods

| Method | What it does |
|---|---|
| `status` | Record whether the service runs. Stopped is a result, not an error. |
| `systemStart`, `systemStop` | Start or stop the service. Stop refuses while containers run, unless `force`. |
| `sync` | Record containers, images, volumes, networks and disk usage. |
| `ensure` | Create and start a container, or do nothing if it already matches. |
| `stop`, `remove` | Both idempotent. `remove` needs `force` if running, `allowUnmanaged` if this model did not create it. |
| `exec` | Run an argument list in a container and store the output. |
| `logs`, `stats` | Store recent log lines, or one resource sample. |
| `pull` | Pull an image. |
| `ensureVolume`, `removeVolume` | Removing needs `confirm` to repeat the name. |
| `ensureNetwork`, `removeNetwork` | User-defined networks. |
| `pruneContainers` | Delete stopped containers. Dry run unless `apply`. |

## How `ensure` decides

A hash of the spec is stored in a label on the container.

- **Same hash:** start it if stopped, otherwise do nothing.
- **Different hash, or a changed secret value:** fail, unless `replace` is
  `drift` or `always`. The replacement is first created as a stopped copy, so a
  bad image, network or option fails while the old container still runs.
  Replacing loses the root filesystem; named volumes survive.
- **No label:** fail. A container made by something else is never changed.

After starting, it waits `settleSeconds` and fails if the container has exited.

Secret values are compared with the running container in memory, and are not
hashed or stored. An existing volume or network is matched by name only. Apple's
CLI has no restart policy; schedule `ensure` instead.

## What is and is not stored

`container list` and `inspect` print each container's environment and
arguments. This model stores neither, nor label values or host mount paths.

`secretEnv` values are sensitive, travel through the CLI's environment instead
of its argv, and are redacted from captured output and errors. The container
itself still holds them: anyone who can run `container inspect` can read them.

`exec` and `logs` store what the container prints, for 7 days. A failed `exec`
stores nothing unless `allowFailure` is set; its output is in the error.

On timeout, `exec` sends SIGTERM to the command. Each command also gets a
`SWAMP_EXEC_ID` variable, used to find it again. One that ignores it is killed
if the container has `sh` and `grep`; otherwise the error says it may still run.

## Not included

Image build, push and registry login (see `@swamp/container-image`), `container
machine`, `container cluster`, and deleting images.
