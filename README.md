# swamp-apple-container

A [swamp](https://github.com/swamp-club/swamp) extension for Apple's
[`container`](https://github.com/apple/container) CLI. Documentation:
[`extensions/models/README.md`](extensions/models/README.md).

## Development

```bash
~/.swamp/deno/deno test --allow-env --allow-run --allow-read extensions/models/
# also check every option against a real CLI, with its service stopped
APPLE_CONTAINER_BIN="$(which container)" \
  ~/.swamp/deno/deno test --allow-env --allow-run --allow-read extensions/models/
```
