# Local desktop builds

This workflow belongs only on `local/daily`. Start contribution branches from
`main`; do not include the local packaging commit in upstream pull requests.

The app is `T3 Code Local`, with bundle ID `com.okbexx.t3code.local`, a blue
development icon, server data in `~/.t3-local/userdata`, and Chromium data in
`~/Library/Application Support/t3code-local-v2`. Its default backend port is 13774. It registers `t3code-local` instead of the official app's URL handler.
Local artifacts have no automatic update feed.

The wrapper selects Node 24.20.0 through Vite Plus and Rust 1.95.0 through
rustup, without changing the machine's default toolchains. If needed, install
the Rust toolchain with `rustup toolchain install 1.95.0 --profile minimal`.

From this worktree:

```sh
./scripts/local-daily update
```

This fast-forwards the clean local `main`, pushes it to the fork, merges official
`upstream/main` into `local/daily`, installs the locked dependencies, runs scoped
lint and typechecks, builds the Apple Silicon app, and installs it in
`/Applications`. It quits and relaunches only `T3 Code Local`. Merge conflicts
stop the command for review; it never resets or force-pushes a branch.

For a contribution you want to use before upstream merges it, first commit and
verify it on its own branch. Merge that branch into `local/daily`, then build:

```sh
git merge --no-ff fix/example
./scripts/local-daily build
./scripts/local-daily install
```

`sync`, `check`, `build`, `install`, and `status` can also run separately.
`build` requires a clean worktree. No background update task is installed.

Each build writes `release/local/<version>/build.json`, recording the exact
source commit, upstream base and version tag. About shows the source commit.
The latest successful build is recorded in `release/local/latest.json`.
Installation preserves the previous app under
`release/local/installed-backups/<timestamp>/`; restore that bundle to
`/Applications/T3 Code Local.app` with the local app closed if rollback is needed.
The server data directory stays in place when replacing the app.

The local app starts with its own environment. Configure Codex using the existing
CLI to reuse `~/.codex/config.toml`, or add other providers in Settings. To connect
a phone, create a pairing link in the local app; the official app's pairing is
for a different environment. This workflow does not build an Android app.
