import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BOAT_ENV_DROP_IN } from "../server.ts";

const UNIT = "bb-host-daemon-test.service";
const ARGV = "/usr/bin/node /opt/bb/bin/bb-app host-daemon --auto-update";

function sandbox({ envFile = true, execStart = `{ path=/usr/bin/node ; argv[]=${ARGV} ; ignore_errors=no ; start_time=[n/a] }` } = {}) {
  const home = mkdtempSync(join(tmpdir(), "boat-env-"));
  const bin = join(home, "bin");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, ".config/systemd/user", UNIT), "");
  if (envFile) writeFileSync(join(home, "env.sh"), "export X=1\n");
  writeFileSync(join(home, "execstart"), execStart);
  writeFileSync(join(bin, "systemctl"), `#!/bin/bash\necho "$*" >> "$HOME/systemctl.log"\n[ "$2" = show ] && cat "$HOME/execstart"\nexit 0\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  const run = () => spawnSync("bash", ["-c", BOAT_ENV_DROP_IN], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, BOAT_ENV_FILE: join(home, "env.sh") },
    encoding: "utf8",
  });
  const dropIn = join(home, ".config/systemd/user", `${UNIT}.d`, "10-boat-env.conf");
  const calls = () => (existsSync(join(home, "systemctl.log")) ? readFileSync(join(home, "systemctl.log"), "utf8") : "");
  return { home, run, dropIn, calls };
}

test("writes a drop-in that sources the env file and wraps the original ExecStart", () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /restarted/);
  const conf = readFileSync(s.dropIn, "utf8");
  assert.equal(conf, `[Service]\nExecStart=\nExecStart=/bin/bash -c ". ${join(s.home, "env.sh")} 2>/dev/null; exec \\"$$0\\" \\"$$@\\"" ${ARGV}\n`);
  assert.match(s.calls(), /--user daemon-reload/);
  assert.match(s.calls(), new RegExp(`--user restart ${UNIT}`));
});

test("is a no-op on the second run", () => {
  const s = sandbox();
  s.run();
  const before = readFileSync(s.dropIn, "utf8");
  const r = s.run();
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /restarted/);
  assert.equal(readFileSync(s.dropIn, "utf8"), before);
});

test("skips when the sandbox has no Boat environment", () => {
  const s = sandbox({ envFile: false });
  const r = s.run();
  assert.equal(r.status, 0);
  assert.equal(existsSync(s.dropIn), false);
  assert.equal(s.calls(), "");
});

test("fails without writing when ExecStart cannot be parsed", () => {
  const s = sandbox({ execStart: "" });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(s.dropIn), false);
  assert.doesNotMatch(s.calls(), /restart/);
});
