# bb-plugin-boat

Run bb threads on [Boat](https://boat.dev) sandboxes. Pick **Boat sandbox** in the New Thread
environment picker: bb creates a box from your base snapshot, enrolls it as a machine, and
gives the thread a Git worktree on it.

## How it works

- **Create:** `POST /boxes` from the named snapshot, then bb's own bootstrap enrolls the box.
- **Suspend / resume:** Boat stop / resume. Resume re-runs the bootstrap, which is a no-op
  when the daemon is already installed.
- **Remove:** deletes the box.
- **Idle:** every minute, machines with no running thread for `idleMinutes` are suspended.
  Active machines get their Boat auto-stop pushed out before it hits.

All the slow work lives in the snapshot, so startup is "create box, bootstrap".

## Settings

| Setting | Default | |
|---|---|---|
| `apiKey` | | Boat API key (secret) |
| `org` | | Boat org that pays for the boxes |
| `snapshot` | `bb-base` | Named snapshot new boxes start from |
| `ttlHours` | 4 | Boat auto-stop; extended while in use |
| `idleMinutes` | 15 | Suspend after this long idle; 0 = never |

## Making the base snapshot

Start a Boat box, set it up, then save it with `POST /named-snapshots {boxId, name}`.

1. Install the CLIs and agents you want, and log them in.
2. Pre-install the hub's bb-app so bootstrap skips the download and npm install. With
   `HUB=https://<your-hub>` and `D=~/.bb-machines/<hub host>`:
   ```bash
   curl -fsS -D h -o bb-app.tgz $HUB/install/bb-app.tgz
   npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher --prefix $D/npm bb-app.tgz
   grep -i '^x-bb-artifact-sha256' h | tr -d '\r' | awk '{print $2}' > $D/host-artifact.sha256
   ```
   Redo this when the hub updates bb; until then bootstrap just downloads the new build.
3. Pre-clone project repos where bb looks for them, so bb skips the clone:
   `$D/checkouts/project-<project id, lowercased, non-alphanumerics as ->`, with `origin`
   set to the project's exact Git remote URL.
4. Do not enroll the base box itself: the data dir must not contain `auth.json` or `host-id`.
