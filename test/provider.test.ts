import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin, { reconnect } from "../server.ts";

type Result = { exitCode: number; stdout?: string; stderr?: string };
type Provider = {
  create(ctx: unknown): Promise<{ status: string; message?: string }>;
  resume(ctx: unknown): Promise<unknown>;
};

const realFetch = globalThis.fetch;
const signal = new AbortController().signal;

/** A plugin wired to a fake bb API and a fake Boat API. `events` records what ran, in order. */
async function harness(opts: { setupCommand?: string; setup?: Result; dropIn?: Result; hostStatuses?: string[] } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const files = new Map<string, string>();
  const statuses = [...(opts.hostStatuses ?? [])];
  let hostGets = 0;

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, "");
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (init.method === "POST" && path === "/sandboxes") return json({ sandbox: { id: "bx_test", name: body.name, state: "running" } });
    if (init.method === "GET" && path === "/sandboxes/bx_test") return json({ sandbox: { id: "bx_test", state: "running" } });
    if (init.method === "PUT" && path === "/sandboxes/bx_test/files") {
      files.set(body.path, Buffer.from(body.content, "base64").toString());
      return json({ ok: true });
    }
    if (init.method === "POST" && path === "/sandboxes/bx_test/commands") {
      const script = files.get(String(body.command).match(/bash -l (\S+)/)?.[1] ?? "") ?? "";
      const isDropIn = script.includes("10-boat-env.conf");
      events.push(isDropIn ? "drop-in" : "setup");
      const r = (isDropIn ? opts.dropIn : opts.setup) ?? { exitCode: 0 };
      return json({ command: { stdout: "", stderr: "", timedOut: false, ...r } });
    }
    throw new Error(`unexpected Boat call ${init.method} ${path}`);
  }) as typeof fetch;

  let provider: Provider | undefined;
  const noop = () => {};
  const bb = {
    settings: {
      define: () => ({
        get: async () => ({
          apiKey: "test-key", snapshot: "", size: "", projectSizes: "", environment: "", org: "",
          setupCommand: opts.setupCommand ?? "", ttlHours: 4, idleMinutes: 15,
        }),
      }),
    },
    experimental_machines: {
      register: (p: Provider) => { provider = p; },
      bootstrap: async () => { events.push("bootstrap"); return { hostId: "host_test" }; },
      getResource: async () => null,
    },
    experimental_environments: { register: noop },
    events: { on: noop },
    background: { schedule: noop },
    status: { needsConfiguration: noop },
    storage: { kv: { set: async () => {}, get: async () => undefined, delete: async () => {} } },
    log: { warn: noop, info: noop },
    sdk: {
      hosts: {
        get: async () => { hostGets++; return { status: statuses.shift() ?? "disconnected" }; },
        list: async () => [],
      },
    },
  };
  await plugin(bb as unknown as BbPluginApi);
  assert.ok(provider, "plugin registered a machine provider");

  const report = { step: noop, log: (t: string) => logs.push(t) };
  const resource = { boxId: "bx_test", key: "thr_test" };
  return {
    events,
    logs,
    hostGets: () => hostGets,
    create: () => provider!.create({ key: "thr_test", attempt: 1, checkpoint: async () => {}, report, signal }),
    resume: () => provider!.resume({ resource, report, signal }),
  };
}

const saved = { ...reconnect };
beforeEach(() => Object.assign(reconnect, { delayMs: 0, intervalMs: 0, attempts: 3 }));
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(reconnect, saved);
});

test("without a setup command, create bootstraps and adds the drop-in", async () => {
  const h = await harness();
  assert.equal((await h.create()).status, "created");
  assert.deepEqual(h.events, ["bootstrap", "drop-in"]);
});

test("the setup command runs before bb bootstraps", async () => {
  const h = await harness({ setupCommand: "bash ~/setup.sh" });
  assert.equal((await h.create()).status, "created");
  assert.deepEqual(h.events, ["setup", "bootstrap", "drop-in"]);
});

test("a failing setup command fails create before bb bootstraps", async () => {
  const h = await harness({ setupCommand: "bash ~/setup.sh", setup: { exitCode: 2, stderr: "first\nboom" } });
  const r = await h.create();
  assert.equal(r.status, "failed");
  assert.equal(r.message, "Setup command failed (exit 2): boom");
  assert.deepEqual(h.events, ["setup"]);
});

test("a failing setup command fails resume", async () => {
  const h = await harness({ setupCommand: "bash ~/setup.sh", setup: { exitCode: 1, stderr: "nope" } });
  await assert.rejects(h.resume(), /Setup command failed \(exit 1\): nope/);
  assert.deepEqual(h.events, ["setup"]);
});

test("after a restart, create waits until the daemon reconnects", async () => {
  const h = await harness({ dropIn: { exitCode: 0, stdout: "restarted\n" }, hostStatuses: ["disconnected", "connected"] });
  assert.equal((await h.create()).status, "created");
  assert.equal(h.hostGets(), 2);
  assert.deepEqual(h.logs.filter((l) => l.startsWith("Warning")), []);
});

test("a daemon that never reconnects logs a warning and create still succeeds", async () => {
  const h = await harness({ dropIn: { exitCode: 0, stdout: "restarted\n" } });
  assert.equal((await h.create()).status, "created");
  assert.equal(h.hostGets(), 3);
  assert.ok(h.logs.includes("Warning: the bb daemon did not reconnect after the restart"));
});

test("a failing drop-in logs a warning and skips the wait", async () => {
  const h = await harness({ dropIn: { exitCode: 1, stderr: "no unit" } });
  assert.equal((await h.create()).status, "created");
  assert.equal(h.hostGets(), 0);
  assert.ok(h.logs.some((l) => l.startsWith("Warning: the bb daemon will not see") && l.endsWith("no unit")));
});

test("no restart means no wait", async () => {
  const h = await harness({ dropIn: { exitCode: 0, stdout: "" } });
  assert.equal((await h.create()).status, "created");
  assert.equal(h.hostGets(), 0);
});
