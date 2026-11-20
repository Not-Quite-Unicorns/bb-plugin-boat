import { strict as assert } from "node:assert";
import { test } from "node:test";
import { type Boat, lastLine, runScript } from "../boat.ts";

type Run = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

function fakeBoat(result: Partial<Run>) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const boat = {
    async writeFile(_id: string, path: string, content: string) {
      files.set(path, content);
    },
    async run(_id: string, command: string) {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
    },
  } as unknown as Boat;
  return { boat, files, commands };
}

const signal = new AbortController().signal;

test("runScript writes the script to a temp file and runs it in a login shell", async () => {
  const f = fakeBoat({ stdout: "ok" });
  const r = await runScript(f.boat, "box", "echo hi", signal);
  assert.equal(r.exitCode, 0);
  const [[path, content]] = [...f.files];
  assert.match(path, /^\/tmp\/bb-script-[0-9a-f-]+\.sh$/);
  assert.equal(content, "echo hi");
  assert.match(f.commands[0], /export HOME=\/home\/user/);
  assert.ok(f.commands[0].includes(`bash -l ${path} </dev/null`));
  assert.ok(f.commands[0].includes(`rm -f ${path}`));
});

test("runScript reports a timeout as exit 124", async () => {
  const r = await runScript(fakeBoat({ exitCode: null, timedOut: true }).boat, "box", "sleep 900", signal);
  assert.equal(r.exitCode, 124);
});

test("runScript reports a missing exit code as 1", async () => {
  const r = await runScript(fakeBoat({ exitCode: null }).boat, "box", "true", signal);
  assert.equal(r.exitCode, 1);
});

test("lastLine prefers stderr", () => {
  assert.equal(lastLine({ stdout: "out", stderr: "first\nlast\n" }), "last");
});

test("lastLine falls back to stdout, then to empty", () => {
  assert.equal(lastLine({ stdout: "a\nb\n", stderr: "  " }), "b");
  assert.equal(lastLine({ stdout: "", stderr: "" }), "");
});

test("lastLine cuts long lines at 300 characters", () => {
  assert.equal(lastLine({ stdout: "", stderr: "x".repeat(500) }).length, 300);
});
