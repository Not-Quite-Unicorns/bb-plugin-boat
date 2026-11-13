// Boat (boat.dev) REST client and a bb MachineExecutor over its commands API.
// Only what the machine provider needs. Never log the API key or sandbox URLs.
import { randomUUID } from "node:crypto";
import type { MachineExecutor, MachineExecutorRequest } from "@get-bb/plugin-sdk";

const BASE = "https://boat.dev/api/v1";

export interface Sandbox {
  id: string;
  name: string | null;
  state: string;
  archiveAfter: string | null;
}

export interface CreateRequest {
  name: string;
  ttlSeconds: number;
  idempotencyKey: string;
  /** Saved snapshot name; empty means Boat's stock image. */
  from: string;
  /** Billing org; empty means the API key's active wallet. */
  org: string;
  /** small, default, large or xlarge; empty inherits the snapshot's size. */
  type: string;
  /** Boat environment (repos, secrets); empty means the account default. */
  environment: string;
}

export class BoatError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(`Boat ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/** The sandbox exists but can't run commands yet (starting or restoring). The command never ran. */
function notReady(err: unknown): boolean {
  if (!(err instanceof BoatError)) return false;
  return /(box|sandbox)_(starting|restoring)|machine_not_running/i.test(`${err.code} ${err.message}`);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export class Boat {
  private readonly apiKey: string;
  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
    const res = await fetch(BASE + path, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new BoatError(res.status, "invalid_json", text.slice(0, 200));
    }
    if (!res.ok || json.ok === false) {
      const e = typeof json.error === "object" && json.error ? json.error : {};
      const detail = JSON.stringify(json.details ?? e.details ?? "").slice(0, 300);
      throw new BoatError(res.status, json.code ?? e.code ?? "http_error", `${json.message ?? e.message ?? `HTTP ${res.status}`} ${detail}`);
    }
    return json;
  }

  private static sandbox(json: Record<string, any>): Sandbox {
    const b = json.sandbox ?? json;
    return { id: b.id, name: b.name ?? null, state: b.state, archiveAfter: b.archiveAfter ?? null };
  }

  async get(id: string, signal?: AbortSignal): Promise<Sandbox | null> {
    try {
      return Boat.sandbox(await this.call("GET", `/sandboxes/${id}`, undefined, {}, signal));
    } catch (err) {
      if (err instanceof BoatError && err.status === 404) return null;
      throw err;
    }
  }

  /** Every sandbox with exactly this name. */
  async findByName(name: string, signal?: AbortSignal): Promise<Sandbox[]> {
    const out: Sandbox[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const q = `name=${encodeURIComponent(name)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const json = await this.call("GET", `/sandboxes?${q}`, undefined, {}, signal);
      for (const b of json.sandboxes ?? []) out.push(Boat.sandbox(b));
      if (!json.pageInfo?.hasMore || !json.pageInfo?.nextCursor) break;
      cursor = json.pageInfo.nextCursor;
    }
    return out;
  }

  /** Same idempotency key + body returns the same sandbox for 24 h. Empty options are left to Boat's defaults. */
  async create(req: CreateRequest, signal?: AbortSignal) {
    const { idempotencyKey, ...rest } = req;
    const body = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== ""));
    return Boat.sandbox(await this.call("POST", "/sandboxes", body, { "Idempotency-Key": idempotencyKey }, signal));
  }

  async stop(id: string, signal?: AbortSignal) {
    await this.call("POST", `/sandboxes/${id}/stop`, {}, {}, signal);
  }

  async resume(id: string, ttlSeconds: number, signal?: AbortSignal) {
    await this.call("POST", `/sandboxes/${id}/resume`, { ttlSeconds }, {}, signal);
  }

  async setTtl(id: string, ttlSeconds: number) {
    await this.call("PATCH", `/sandboxes/${id}`, { ttlSeconds });
  }

  /** Delete and wait until the sandbox is gone (GET returns 404). */
  async delete(id: string, signal?: AbortSignal) {
    try {
      await this.call("DELETE", `/sandboxes/${id}`, undefined, { "X-Ascii-Confirm-Delete": id }, signal);
    } catch (err) {
      if (err instanceof BoatError && err.status === 404) return;
      throw err;
    }
    for (let i = 0; i < 60; i++) {
      if ((await this.get(id, signal)) === null) return;
      await sleep(3_000, signal);
    }
    throw new Error(`Boat sandbox ${id} still exists 3 minutes after delete`);
  }

  /** Wait until the sandbox reaches one of `states`. */
  async waitFor(id: string, states: string[], signal: AbortSignal, maxMs = 10 * 60_000) {
    const end = Date.now() + maxMs;
    for (;;) {
      const box = await this.get(id, signal);
      if (box === null) throw new Error(`Boat sandbox ${id} is gone`);
      if (states.includes(box.state)) return box;
      if (Date.now() > end) throw new Error(`Boat sandbox ${id} is still ${box.state} after ${maxMs / 60_000} min`);
      await sleep(2_000, signal);
    }
  }

  /** Run a shell string as `user`, retrying while the sandbox is still starting. Max 600 s. */
  async run(id: string, command: string, timeoutSeconds: number, signal: AbortSignal) {
    return this.whenReady(async () => {
      const json = await this.call("POST", `/sandboxes/${id}/commands`, { command, timeoutSeconds }, {}, signal);
      const r = json.command ?? json;
      return { exitCode: r.exitCode as number | null, stdout: (r.stdout ?? "") as string, stderr: (r.stderr ?? "") as string, timedOut: !!r.timedOut };
    }, signal);
  }

  async writeFile(id: string, path: string, content: string, signal: AbortSignal) {
    await this.whenReady(
      () => this.call("PUT", `/sandboxes/${id}/files`, { path, content: Buffer.from(content).toString("base64"), encoding: "base64" }, {}, signal),
      signal,
    );
  }

  private async whenReady<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const end = Date.now() + 10 * 60_000;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!notReady(err) || Date.now() > end) throw err;
        await sleep(1_000, signal);
      }
    }
  }
}

const quote = (argv: string[]) => argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");

/**
 * bb's bootstrap runs argv + stdin through this. Boat runs one shell string with an
 * empty HOME and no stdin, so we quote argv, set HOME, and pass stdin via a temp file.
 * Output arrives once, when the command ends.
 */
export function boatExecutor(boat: Boat, boxId: string): MachineExecutor {
  return {
    async exec(req: MachineExecutorRequest) {
      const env = "export HOME=/home/user XDG_RUNTIME_DIR=/run/user/$(id -u); cd /home/user;";
      let command = `${env} ${quote(req.command)} </dev/null`;
      if (req.stdin.length > 0) {
        const f = `/tmp/bb-stdin-${randomUUID()}`;
        await boat.writeFile(boxId, f, req.stdin, req.signal);
        command = `${env} chmod 600 ${f}; ${quote(req.command)} <${f}; rc=$?; rm -f ${f}; exit $rc`;
      }
      const seconds = Math.min(600, Math.max(1, Math.ceil(req.timeoutMs / 1000)));
      const r = await boat.run(boxId, command, seconds, req.signal);
      if (r.stdout) req.onOutput(r.stdout);
      if (r.stderr) req.onOutput(r.stderr);
      return { exitCode: r.timedOut ? 124 : (r.exitCode ?? 1) };
    },
  };
}
