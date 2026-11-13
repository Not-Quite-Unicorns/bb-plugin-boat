// Boat (boat.dev) REST client and a bb MachineExecutor over its commands API.
// Only what the machine provider needs. Never log the API key or box URLs.
import { randomUUID } from "node:crypto";
import type { MachineExecutor, MachineExecutorRequest } from "@get-bb/plugin-sdk";

const BASE = "https://boat.dev/api/box/v1";

export interface Box {
  id: string;
  name: string | null;
  state: string;
  archiveAfter: string | null;
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

/** The box exists but can't run commands yet (starting or restoring). The command never ran. */
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

  private static box(json: Record<string, any>): Box {
    const b = json.box ?? json.sandbox ?? json;
    return { id: b.id, name: b.name ?? null, state: b.state, archiveAfter: b.archiveAfter ?? null };
  }

  async get(id: string, signal?: AbortSignal): Promise<Box | null> {
    try {
      return Boat.box(await this.call("GET", `/boxes/${id}`, undefined, {}, signal));
    } catch (err) {
      if (err instanceof BoatError && err.status === 404) return null;
      throw err;
    }
  }

  async list(signal?: AbortSignal): Promise<Box[]> {
    const out: Box[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const json = await this.call("GET", `/boxes?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, {}, signal);
      for (const b of json.boxes ?? json.sandboxes ?? []) out.push(Boat.box(b));
      if (!json.pageInfo?.hasMore || !json.pageInfo?.nextCursor) break;
      cursor = json.pageInfo.nextCursor;
    }
    return out;
  }

  /** Same idempotency key + body returns the same box for 24 h. */
  async create(req: { from: string; name: string; org: string; ttlSeconds: number; idempotencyKey: string }, signal?: AbortSignal) {
    const { idempotencyKey, ...body } = req;
    return Boat.box(await this.call("POST", "/boxes", body, { "Idempotency-Key": idempotencyKey }, signal));
  }

  async stop(id: string, signal?: AbortSignal) {
    await this.call("POST", `/boxes/${id}/stop`, {}, {}, signal);
  }

  async resume(id: string, ttlSeconds: number, signal?: AbortSignal) {
    await this.call("POST", `/boxes/${id}/resume`, { ttlSeconds }, {}, signal);
  }

  async setTtl(id: string, ttlSeconds: number) {
    await this.call("PATCH", `/boxes/${id}`, { ttlSeconds });
  }

  /** Delete and wait until the box is gone (GET returns 404). */
  async delete(id: string, signal?: AbortSignal) {
    try {
      await this.call("DELETE", `/boxes/${id}`, undefined, { "X-Ascii-Confirm-Delete": id }, signal);
    } catch (err) {
      if (err instanceof BoatError && err.status === 404) return;
      throw err;
    }
    for (let i = 0; i < 60; i++) {
      if ((await this.get(id, signal)) === null) return;
      await sleep(3_000, signal);
    }
    throw new Error(`Boat box ${id} still exists 3 minutes after delete`);
  }

  /** Wait until the box reaches one of `states`. */
  async waitFor(id: string, states: string[], signal: AbortSignal, maxMs = 10 * 60_000) {
    const end = Date.now() + maxMs;
    for (;;) {
      const box = await this.get(id, signal);
      if (box === null) throw new Error(`Boat box ${id} is gone`);
      if (states.includes(box.state)) return box;
      if (Date.now() > end) throw new Error(`Boat box ${id} is still ${box.state} after ${maxMs / 60_000} min`);
      await sleep(2_000, signal);
    }
  }

  /** Run a shell string as `user`, retrying while the box is still starting. Max 600 s. */
  async run(id: string, command: string, timeoutSeconds: number, signal: AbortSignal) {
    return this.whenReady(async () => {
      const json = await this.call("POST", `/boxes/${id}/commands`, { command, timeoutSeconds }, {}, signal);
      const r = json.command ?? json;
      return { exitCode: r.exitCode as number | null, stdout: (r.stdout ?? "") as string, stderr: (r.stderr ?? "") as string, timedOut: !!r.timedOut };
    }, signal);
  }

  async writeFile(id: string, path: string, content: string, signal: AbortSignal) {
    await this.whenReady(
      () => this.call("PUT", `/boxes/${id}/files`, { path, content: Buffer.from(content).toString("base64"), encoding: "base64" }, {}, signal),
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
