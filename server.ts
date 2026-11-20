// Boat sandboxes (boat.dev) as bb machines.
//
// A new machine is a Boat sandbox, from Boat's stock image or a saved snapshot you
// prepare (tools, logins, bb-app pre-installed, repos pre-cloned). bb's own bootstrap
// then enrolls it. Put the slow work in the snapshot and create is: make sandbox, bootstrap.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Boat, boatExecutor, lastLine, runScript, sleep } from "./boat.ts";

const PROVIDER_ID = "boat";
const MINUTE = 60_000;
/** Extend Boat's auto-stop when it is closer than this. */
const TTL_MARGIN_MS = 30 * MINUTE;

// Boat exports environment variables only to login shells, through /run/ascii-secrets/env.sh.
// The bb daemon runs as a systemd user service, so this drop-in sources the same file before
// starting it. Skips when the drop-in exists or the sandbox has no Boat environment.
const BOAT_ENV_DROP_IN = String.raw`set -e
[ -r /run/ascii-secrets/env.sh ] || exit 0
u=$(cd ~/.config/systemd/user && ls bb-host-daemon-*.service | head -1)
d=~/.config/systemd/user/$u.d
[ -f "$d/10-boat-env.conf" ] && exit 0
orig=$(systemctl --user show "$u" -p ExecStart --value | sed -nE 's/.*argv\[\]=([^;]*) ;.*/\1/p' | sed -E 's/ +$//')
[ -n "$orig" ]
mkdir -p "$d"
cat > "$d/10-boat-env.conf" <<EOF
[Service]
ExecStart=
ExecStart=/bin/bash -c ". /run/ascii-secrets/env.sh 2>/dev/null; exec \"\$\$0\" \"\$\$@\"" $orig
EOF
systemctl --user daemon-reload
systemctl --user restart "$u"
echo restarted
`;

interface Config {
  boat: Boat;
  org: string;
  snapshot: string;
  size: string;
  projectSizes: Map<string, string>;
  environment: string;
  setupCommand: string;
  ttlSeconds: number;
  idleMinutes: number;
}

interface Resource {
  boxId: string;
  key: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isMachineBusy = (err: unknown) => err instanceof Error && "code" in err && err.code === "machine_busy";
/** "a=large, b=xlarge" -> lowercase key -> size. */
const parseProjectSizes = (raw: string) =>
  new Map(
    raw
      .split(",")
      .map((pair) => pair.split("=").map((x) => x.trim()))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k.toLowerCase(), v] as [string, string]),
  );
const boxName = (key: string) => `bb ${key}`.slice(0, 120);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: { type: "string", label: "Boat API key", secret: true },
    snapshot: {
      type: "string",
      label: "Saved snapshot",
      description: "Saved Boat snapshot new machines start from. Empty uses Boat's stock image.",
      default: "",
    },
    size: {
      type: "string",
      label: "Size",
      description: "small, default, large or xlarge. Empty uses the snapshot's size.",
      default: "",
    },
    projectSizes: {
      type: "string",
      label: "Size per project",
      description: "Overrides Size for some projects. Comma-separated project=size, by project name or id, e.g. \"web-app=large, proj_abc=xlarge\".",
      default: "",
    },
    environment: {
      type: "string",
      label: "Boat environment",
      description: "Boat environment with the repos and secrets to attach. Empty uses your default.",
      default: "",
    },
    setupCommand: {
      type: "string",
      label: "Setup command",
      description:
        "Shell command run in a login shell on the sandbox before bb connects, on create and on resume. Boat skips the environment's repository setup script when the snapshot already holds the repository; put that script here. Must be safe to run again. Max 10 minutes.",
      default: "",
    },
    org: { type: "string", label: "Billing org", description: "Boat org id or name to bill. Empty uses your active wallet.", default: "" },
    ttlHours: { type: "number", label: "Boat auto-stop (hours)", description: "Extended automatically while the machine is in use.", default: 4 },
    idleMinutes: { type: "number", label: "Suspend after idle (minutes, 0 = never)", default: 15 },
  });

  async function config(): Promise<Config | { error: string }> {
    const s = await settings.get();
    if (!s.apiKey) return { error: "Set the Boat API key in the plugin settings." };
    return {
      boat: new Boat(s.apiKey),
      org: s.org.trim(),
      snapshot: s.snapshot.trim(),
      size: s.size.trim(),
      projectSizes: parseProjectSizes(s.projectSizes),
      environment: s.environment.trim(),
      setupCommand: s.setupCommand.trim(),
      ttlSeconds: Math.round(s.ttlHours * 3600),
      idleMinutes: s.idleMinutes,
    };
  }
  async function mustConfig() {
    const c = await config();
    if ("error" in c) throw new Error(c.error);
    return c;
  }

  /** Size for this machine: the thread's project override, else the default. Machine keys are thread ids. */
  async function sizeFor(c: Config, key: string, signal: AbortSignal) {
    if (c.projectSizes.size === 0 || !key.startsWith("thr_")) return c.size;
    try {
      const thread = await bb.sdk.threads.get({ threadId: key, signal });
      const project = await bb.sdk.projects.get({ projectId: thread.projectId, signal });
      return c.projectSizes.get(project.id.toLowerCase()) ?? c.projectSizes.get(project.name.toLowerCase()) ?? c.size;
    } catch (err) {
      bb.log.warn(`Using the default size; could not read the project for ${key}: ${message(err)}`);
      return c.size;
    }
  }

  const idleKey = (hostId: string) => `idle/${hostId}`;
  const bump = (hostId: string) => bb.storage.kv.set(idleKey(hostId), Date.now());

  type Report = { step(t: string): void; log(t: string): void };

  async function passBoatEnvironment(boat: Boat, r: Resource, hostId: string, report: Report, signal: AbortSignal) {
    const out = await runScript(boat, r.boxId, BOAT_ENV_DROP_IN, signal);
    if (out.exitCode !== 0) {
      report.log(`Warning: the bb daemon will not see the Boat environment's variables: ${lastLine(out)}`);
      return;
    }
    if (!out.stdout.includes("restarted")) return;
    report.step("Restarting the bb daemon with the Boat environment…");
    await sleep(5_000, signal);
    for (let i = 0; i < 40; i++) {
      if ((await bb.sdk.hosts.get({ hostId })).status === "connected") return;
      await sleep(3_000, signal);
    }
    report.log("Warning: the bb daemon did not reconnect within two minutes of the restart");
  }

  async function bootstrap(c: Config, r: Resource, report: Report, signal: AbortSignal) {
    const t0 = Date.now();
    if (c.setupCommand) {
      report.step("Running the setup command…");
      const out = await runScript(c.boat, r.boxId, c.setupCommand, signal);
      if (out.exitCode !== 0) throw new Error(`Setup command failed (exit ${out.exitCode}): ${lastLine(out)}`);
      report.log(`Setup command finished in ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    report.step("Connecting the bb daemon…");
    const { hostId } = await bb.experimental_machines.bootstrap({ key: r.key, executor: boatExecutor(c.boat, r.boxId), report, signal });
    report.log(`Daemon connected in ${Math.round((Date.now() - t0) / 1000)} s`);
    await passBoatEnvironment(c.boat, r, hostId, report, signal);
    await bump(hostId);
    return hostId;
  }

  bb.experimental_machines.register({
    id: PROVIDER_ID,
    displayName: "Boat",
    description: "Run threads on Boat sandboxes.",
    icon: "./boat.svg",
    ephemeral: true,
    async availability() {
      const c = await config();
      return "error" in c ? { status: "setup-required", message: c.error } : { status: "available" };
    },
    async create({ key, attempt, checkpoint, report, signal }) {
      try {
        const c = await mustConfig();
        const t0 = Date.now();
        const size = await sizeFor(c, key, signal);
        report.step(`Creating a ${size || "default"} Boat sandbox from ${c.snapshot || "the stock image"}…`);
        const box = await c.boat.create(
          {
            name: boxName(key),
            ttlSeconds: c.ttlSeconds,
            idempotencyKey: `${key}:${attempt}`,
            from: c.snapshot,
            org: c.org,
            type: size,
            environment: c.environment,
          },
          signal,
        );
        const resource: Resource = { boxId: box.id, key };
        await checkpoint({ ...resource });
        report.log(`Boat sandbox ${box.id} created in ${Math.round((Date.now() - t0) / 1000)} s`);
        await bootstrap(c, resource, report, signal);
        report.log(`Ready in ${Math.round((Date.now() - t0) / 1000)} s`);
        return { status: "created", name: `Boat ${box.id}`, resource: { ...resource } };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: message(err) };
      }
    },
    async reconcileCleanup({ key, signal }) {
      try {
        const { boat } = await mustConfig();
        for (const box of await boat.findByName(boxName(key), signal)) await boat.delete(box.id, signal);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: message(err) };
      }
    },
    async suspend({ resource, report, signal }) {
      const r = resource as unknown as Resource;
      const { boat } = await mustConfig();
      report.step("Stopping the Boat sandbox…");
      await boat.stop(r.boxId, signal);
      await boat.waitFor(r.boxId, ["archived", "stopped"], signal);
      return { resource };
    },
    async resume({ resource, report, signal }) {
      const r = resource as unknown as Resource;
      const c = await mustConfig();
      report.step("Resuming the Boat sandbox…");
      const box = await c.boat.get(r.boxId, signal);
      if (box === null) throw new Error(`Boat sandbox ${r.boxId} no longer exists`);
      if (!["ready", "idle", "running"].includes(box.state)) await c.boat.resume(r.boxId, c.ttlSeconds, signal);
      await bootstrap(c, r, report, signal);
      return { resource };
    },
    async remove({ hostId, resource, signal }) {
      try {
        const { boat } = await mustConfig();
        await boat.delete((resource as unknown as Resource).boxId, signal);
        await bb.storage.kv.delete(idleKey(hostId));
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: message(err) };
      }
    },
  });

  bb.experimental_environments.register({
    id: "boat",
    displayName: "Boat sandbox",
    description: "A new Boat sandbox for this thread, with its own Git worktree.",
    icon: "./boat.svg",
    machineProviderId: PROVIDER_ID,
    environmentProviderId: "git-worktree",
  });

  // Idle tracking: thread activity and terminal input keep a machine awake.
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if ((thread.status !== "starting" && thread.status !== "active") || thread.environmentId === null) return;
    await bump((await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId);
  });
  bb.events.on("experimental_terminal.input", async ({ terminal }) => bump(terminal.hostId));

  // Every minute: suspend idle machines, and keep Boat's auto-stop ahead of active ones.
  bb.background.schedule("boat-idle", "* * * * *", async () => {
    const c = await config();
    if ("error" in c) return;
    const now = Date.now();
    for (const host of await bb.sdk.hosts.list()) {
      if (host.machineProviderId !== PROVIDER_ID || host.lifecycle.phase !== "active") continue;
      try {
        const busy =
          (await bb.sdk.threads.count({ hostId: host.id, status: "starting" })).total +
          (await bb.sdk.threads.count({ hostId: host.id, status: "active" })).total;
        const last = await bb.storage.kv.get<number>(idleKey(host.id));
        if (busy > 0 || last === undefined) await bump(host.id);
        else if (c.idleMinutes > 0 && now - last > c.idleMinutes * MINUTE) {
          await bb.sdk.hosts.experimental_suspend({ hostId: host.id });
          bb.log.info(`Suspended idle Boat machine ${host.id}`);
          continue;
        }
        const r = (await bb.experimental_machines.getResource(host.id)) as unknown as Resource | null;
        const box = r && (await c.boat.get(r.boxId));
        if (box?.archiveAfter && Date.parse(box.archiveAfter) - now < TTL_MARGIN_MS) await c.boat.setTtl(box.id, c.ttlSeconds);
      } catch (err) {
        if (!isMachineBusy(err)) bb.log.warn(`Boat idle check for ${host.id} failed: ${message(err)}`);
      }
    }
  });

  const c = await config();
  if ("error" in c) bb.status.needsConfiguration(c.error);
}
