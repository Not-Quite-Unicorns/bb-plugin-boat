# bb-plugin-boat

Run bb threads on [Boat](https://boat.dev) sandboxes. Pick **Boat sandbox** in the New Thread
environment picker: bb creates a sandbox, enrolls it as a machine, and gives the thread a Git
worktree on it.

## Setup

1. Create a Boat API key: `boat api-key create bb` or the [dashboard](https://boat.dev/dashboard).
2. Install the plugin and paste the key into its settings.

That's it. New machines start from Boat's stock Ubuntu image, which has everything bb needs.
For faster starts, make a saved snapshot (below).

## How it works

- **Create:** `POST /sandboxes`, runs the optional setup command, then bb's own bootstrap installs
  and enrolls the bb daemon. A systemd drop-in makes the daemon source the Boat environment's
  variables, so threads see them.
- **Suspend / resume:** Boat stop / resume. Resume re-runs the bootstrap, which is a no-op
  when the daemon is already installed.
- **Remove:** deletes the sandbox.
- **Idle:** every minute, machines with no running thread for `idleMinutes` are suspended.
  Active machines get their Boat auto-stop pushed out before it hits.

## Settings

| Setting | Default | |
|---|---|---|
| `apiKey` | | Boat API key (secret) |
| `snapshot` | stock image | Saved snapshot new machines start from |
| `size` | snapshot's size | `small`, `default`, `large` or `xlarge` |
| `projectSizes` | empty | Per-project size, e.g. `web-app=large, proj_abc=xlarge` (project name or id) |
| `environment` | your default | Boat environment with the repos and secrets to attach |
| `setupCommand` | empty | Shell command run in a login shell before bb connects, on create and resume |
| `org` | active wallet | Boat org id or name to bill |
| `ttlHours` | 4 | Boat auto-stop; extended while in use |
| `idleMinutes` | 15 | Suspend after this long idle; 0 = never |

## Secrets

Keep tokens out of the snapshot. Two places work:

- `bb machine env set NAME` (value on stdin) gives every bb machine's threads the variable.
- A Boat environment (`environment` setting) attaches its secrets to each sandbox. Boat exports
  its variables only to login shells, through `/run/ascii-secrets/env.sh`; the plugin adds a
  systemd drop-in so the bb daemon, and every thread it starts, sources the same file. After
  `boat env upgrade`, a running machine picks up new values when it is suspended and resumed.

## Setup command

Boat runs an environment's repository setup script on create, resume and fork, but skips it
when the snapshot already holds the repository. Set `setupCommand` to run it anyway, for
example `bash ~/.config/my-env/bootstrap.sh`. It runs as `user` in a login shell, with the
environment's variables and secret files in place, before bb connects. It must be safe to
run again, since resume runs it too. A non-zero exit fails the create or resume. Boat limits
it to 10 minutes.

## Faster starts: a saved snapshot

A stock sandbox spends most of its start downloading and installing bb. Do that once, save
the result, and set `snapshot` to its name.

1. `boat new`, then `boat ssh <id>`.
2. Install the CLIs and agents you want.
3. Pre-install the hub's bb-app so bootstrap skips the download and npm install. With
   `HUB=https://<your-hub>` and `D=~/.bb-machines/<hub host>`:
   ```bash
   curl -fsS -D h -o bb-app.tgz $HUB/install/bb-app.tgz
   npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher --prefix $D/npm bb-app.tgz
   grep -i '^x-bb-artifact-sha256' h | tr -d '\r' | awk '{print $2}' > $D/host-artifact.sha256
   ```
   Redo this when the hub updates bb; until then bootstrap just downloads the new build.
4. Optional: pre-clone project repos where bb looks for them, so bb skips the clone:
   `$D/checkouts/project-<project id, lowercased, non-alphanumerics as ->`, with `origin`
   set to the project's exact Git remote URL. Run the project's install there too, to fill
   the package manager cache.
5. Do not enroll this sandbox in bb: the data dir must not contain `auth.json` or `host-id`.
6. `boat snapshot <id> <name>`, then set `snapshot` to `<name>`.
