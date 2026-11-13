// Boat sandboxes (boat.dev) as bb machines.
//
// A new machine is a Boat box created from a named snapshot you prepare once (CLIs,
// logins, caches, bb-app pre-installed, repos pre-cloned). bb's own bootstrap then
// enrolls it. Everything slow lives in the snapshot, so create is: make box, bootstrap.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Boat, boatExecutor } from "./boat.ts";

const PROVIDER_ID = "boat";
const MINUTE = 60_000;
/** Extend Boat's auto-stop when it is closer than this. */
const TTL_MARGIN_MS = 30 * MINUTE;

interface Config {
  boat: Boat;
  org: string;
  snapshot: string;
  ttlSeconds: number;
  idleMinutes: number;
}

interface Resource {
  boxId: string;
  key: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isMachineBusy = (err: unknown) => err instanceof Error && "code" in err && err.code === "machine_busy";
const boxName = (key: string) => `bb ${key}`.slice(0, 120);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: { type: "string", label: "Boat API key", secret: true },
    org: { type: "string", label: "Billing org", description: "Boat org id or name new boxes bill to." },
    snapshot: {
      type: "string",
      label: "Base snapshot",
      description: "Named Boat snapshot every new machine starts from.",
      default: "bb-base",
    },
    ttlHours: { type: "number", label: "Boat auto-stop (hours)", description: "Extended automatically while the machine is in use.", default: 4 },
    idleMinutes: { type: "number", label: "Suspend after idle (minutes, 0 = never)", default: 15 },
  });

  async function config(): Promise<Config | { error: string }> {
    const s = await settings.get();
    if (!s.apiKey) return { error: "Set the Boat API key in the plugin settings." };
    if (!s.org) return { error: "Set the Boat billing org in the plugin settings." };
    if (!s.snapshot) return { error: "Set the base snapshot in the plugin settings." };
    return { boat: new Boat(s.apiKey), org: s.org, snapshot: s.snapshot, ttlSeconds: Math.round(s.ttlHours * 3600), idleMinutes: s.idleMinutes };
  }
  async function mustConfig() {
    const c = await config();
    if ("error" in c) throw new Error(c.error);
    return c;
  }

  const idleKey = (hostId: string) => `idle/${hostId}`;
  const bump = (hostId: string) => bb.storage.kv.set(idleKey(hostId), Date.now());

  async function bootstrap(boat: Boat, r: Resource, report: { step(t: string): void; log(t: string): void }, signal: AbortSignal) {
    const t0 = Date.now();
    report.step("Connecting the bb daemon…");
    const { hostId } = await bb.experimental_machines.bootstrap({ key: r.key, executor: boatExecutor(boat, r.boxId), report, signal });
    report.log(`Daemon connected in ${Math.round((Date.now() - t0) / 1000)} s`);
    await bump(hostId);
    return hostId;
  }

  bb.experimental_machines.register({
    id: PROVIDER_ID,
    displayName: "Boat",
    description: "Run threads on Boat sandboxes created from your base snapshot.",
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
        report.step(`Creating a Boat box from ${c.snapshot}…`);
        const box = await c.boat.create(
          { from: c.snapshot, name: boxName(key), org: c.org, ttlSeconds: c.ttlSeconds, idempotencyKey: `${key}:${attempt}` },
          signal,
        );
        const resource: Resource = { boxId: box.id, key };
        await checkpoint({ ...resource });
        report.log(`Boat box ${box.id} created in ${Math.round((Date.now() - t0) / 1000)} s`);
        await bootstrap(c.boat, resource, report, signal);
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
        for (const box of await boat.list(signal)) if (box.name === boxName(key)) await boat.delete(box.id, signal);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: message(err) };
      }
    },
    async suspend({ resource, report, signal }) {
      const r = resource as unknown as Resource;
      const { boat } = await mustConfig();
      report.step("Stopping the Boat box…");
      await boat.stop(r.boxId, signal);
      await boat.waitFor(r.boxId, ["archived", "stopped"], signal);
      return { resource };
    },
    async resume({ resource, report, signal }) {
      const r = resource as unknown as Resource;
      const c = await mustConfig();
      report.step("Resuming the Boat box…");
      const box = await c.boat.get(r.boxId, signal);
      if (box === null) throw new Error(`Boat box ${r.boxId} no longer exists`);
      if (!["ready", "idle", "running"].includes(box.state)) await c.boat.resume(r.boxId, c.ttlSeconds, signal);
      await bootstrap(c.boat, r, report, signal);
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
