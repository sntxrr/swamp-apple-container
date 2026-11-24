import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  createArgs,
  model,
  parseArray,
  parseContainers,
  parseDiskUsage,
  parseImages,
  parseStatus,
  redact,
  type RunOptions,
  type RunResult,
  setRunner,
  SPEC_LABEL,
  specHash,
  tail,
} from "./apple_container.ts";

// --- a small stateful stand-in for the CLI ---------------------------------

interface Fake {
  state: string;
  hash?: string;
}
interface Call {
  args: string[];
  opts: RunOptions;
}

const SECRET = "s3cr3t-value";

/** Shape taken from ManagedContainer.encode in apple/container 1.7.1. */
function row(id: string, f: Fake) {
  return {
    id,
    configuration: {
      id,
      image: { reference: "docker.io/library/alpine:latest", descriptor: {} },
      labels: { private: SECRET, ...(f.hash ? { [SPEC_LABEL]: f.hash } : {}) },
      initProcess: {
        executable: "/bin/sh",
        arguments: ["--token", SECRET],
        environment: [`TOKEN=${SECRET}`],
      },
      publishedPorts: [{
        hostAddress: "127.0.0.1",
        hostPort: 8080,
        containerPort: 80,
        proto: "tcp",
        count: 1,
      }],
      mounts: [{
        type: { virtiofs: {} },
        source: "/private/src",
        destination: "/data",
        options: ["ro"],
      }],
      resources: { cpus: 2, memoryInBytes: 1073741824 },
      creationDate: "2026-11-24T00:00:00Z",
    },
    status: {
      state: f.state,
      networks: [{ network: "default", ipv4Address: "192.0.2.3/24" }],
      startedDate: "2026-11-24T00:00:01Z",
    },
  };
}

class Cli {
  containers = new Map<string, Fake>();
  volumes = new Set<string>();
  calls: Call[] = [];
  service = true;
  crashOnStart = false;
  logText = "line\n";
  failDelete = new Set<string>();
  execResult: RunResult = { code: 0, stdout: "ok", stderr: "" };

  run = (_b: string, args: string[], opts: RunOptions): Promise<RunResult> => {
    this.calls.push({ args, opts });
    return Promise.resolve(this.answer(args));
  };
  answer(args: string[]): RunResult {
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
    const bad = (stderr: string): RunResult => ({
      code: 1,
      stdout: "",
      stderr,
    });
    const last = args[args.length - 1];
    switch (`${args[0]} ${args[1]}`) {
      case "system status":
        return this.service
          ? ok('{"status":"running","client":{"version":"1.7.1"}}')
          : { code: 1, stdout: '{"status":"unregistered"}', stderr: "" };
      case "system start":
        this.service = true;
        return ok();
      case "system stop":
        this.service = false;
        return ok();
      case "system df": {
        const u = { total: 1, active: 1, sizeInBytes: 5, reclaimable: 0 };
        return ok(JSON.stringify({ images: u, containers: u, volumes: u }));
      }
      case "volume list":
        return ok(
          JSON.stringify(
            [...this.volumes].map((id) => ({ id, configuration: {} })),
          ),
        );
      case "volume create":
        this.volumes.add(last);
        return ok();
      case "volume delete":
        this.volumes.delete(last);
        return ok();
      case "network list":
      case "image list":
        return ok("[]");
    }
    if (!this.service) return bad("XPC connection error");
    switch (args[0]) {
      case "list":
        return ok(
          JSON.stringify([...this.containers].map(([k, v]) => row(k, v))),
        );
      case "create": {
        const id = args.find((a) => a.startsWith("--name="))!.slice(7);
        const prefix = `--label=${SPEC_LABEL}=`;
        const hash = args.find((a) => a.startsWith(prefix))!.slice(
          prefix.length,
        );
        this.containers.set(id, { state: "stopped", hash });
        return ok(id);
      }
      case "start":
        this.containers.get(last)!.state = this.crashOnStart
          ? "stopped"
          : "running";
        return ok(last);
      case "stop":
        this.containers.get(last)!.state = "stopped";
        return ok(last);
      case "delete":
        if (this.failDelete.has(last)) return bad("busy");
        this.containers.delete(last);
        return ok(last);
      case "exec":
        return this.execResult;
      case "logs":
        return ok(this.logText);
      case "stats":
        return ok('[{"id":"web","cpuUtilization":0.5,"numProcesses":3}]');
    }
    return bad(`unexpected: ${args.join(" ")}`);
  }
  verbs() {
    return this.calls.map((c) => c.args[0]);
  }
}

type Written = {
  spec: string;
  instance: string;
  data: Record<string, unknown>;
};

/** Run a method as swamp does: arguments and records pass their schemas. */
async function run(
  cli: Cli,
  method: keyof typeof model.methods,
  input: Record<string, unknown> = {},
): Promise<Written[]> {
  const written: Written[] = [];
  const restore = setRunner(cli.run);
  try {
    const m = model.methods[method];
    const args = (m.arguments as z.ZodType).parse(input);
    const ctx = {
      globalArgs: model.globalArguments.parse({}),
      logger: { info: () => {} },
      writeResource: (
        spec: string,
        instance: string,
        data: Record<string, unknown>,
      ) => {
        // swamp refuses a second write to one instance in one run.
        assertFalse(
          written.some((w) => w.instance === instance),
          `duplicate instance ${instance}`,
        );
        const schema =
          model.resources[spec as keyof typeof model.resources].schema;
        written.push({
          spec,
          instance,
          data: schema.parse(data) as Record<string, unknown>,
        });
        return Promise.resolve({});
      },
    };
    const result = await (m.execute as (
      a: unknown,
      c: unknown,
    ) => Promise<{ dataHandles: unknown[] }>)(args, ctx);
    // swamp fails a method that does not return its handles.
    assertEquals(result.dataHandles.length, written.length);
  } finally {
    restore();
  }
  return written;
}

const SPEC = { name: "web", image: "alpine:3.22", settleSeconds: 0 };
const spec = (over: Record<string, unknown> = {}) => {
  const { settleSeconds: _, ...base } = SPEC;
  const parsed = model.methods.ensure.arguments.parse({ ...base, ...over });
  const { replace: _r, settleSeconds: _s, stopSeconds: _t, ...s } = parsed;
  return s;
};

// --- parsing ----------------------------------------------------------------

Deno.test("containers never carry env, arguments, labels or host paths", () => {
  const rows = parseContainers(
    JSON.stringify([row("web", { state: "running", hash: "h" })]),
  );
  assertFalse(JSON.stringify(rows).includes(SECRET));
  assertFalse(JSON.stringify(rows).includes("/private/src"));
  assertEquals(rows[0].ports[0].hostPort, 8080);
  assertEquals(rows[0].mounts, [{ destination: "/data", readOnly: true }]);
  assertEquals(rows[0].addresses[0].ipv4, "192.0.2.3/24");
  assert(rows[0].managed);
});

Deno.test("unusable output throws instead of reading as empty", () => {
  assertThrows(() => parseArray("", "list"));
  assertThrows(() => parseArray("{}", "list"));
  assertThrows(() => parseArray('[{"name":"x"}]', "list"));
  assertThrows(() => parseDiskUsage("{}"));
  assertThrows(() => parseStatus("{}"));
  assertEquals(parseArray("[]", "list"), []);
});

Deno.test("image attestation variants are dropped", () => {
  const [img] = parseImages(JSON.stringify([{
    id: "a",
    configuration: { name: "alpine", descriptor: { digest: "sha256:a" } },
    variants: [
      { platform: { os: "linux", architecture: "arm64" }, size: 1 },
      { platform: { os: "unknown", architecture: "unknown" }, size: 1 },
    ],
  }]));
  assertEquals(img.platforms, [{ platform: "linux/arm64", sizeBytes: 1 }]);
});

Deno.test("redact and tail", () => {
  assertEquals(redact("abc ab", ["ab", "abc", ""]), "*** ***");
  assertEquals(tail("12345", 3), { text: "345", truncated: true });
});

// --- spec and argv ----------------------------------------------------------

Deno.test("secret values never reach argv; env is joined", () => {
  const a = createArgs(
    spec({ env: { A: "-x" }, secretEnv: { TOKEN: SECRET } }),
    "h",
  );
  assertFalse(a.join(" ").includes(SECRET));
  assert(a.includes("--env=TOKEN"));
  assert(a.includes("--env=A=-x"));
  assertEquals(a[a.length - 1], "alpine:3.22");
});

Deno.test("option-like images and names are rejected", () => {
  assertThrows(() => spec({ image: "--privileged" }));
  assertThrows(() => spec({ name: "-x" }));
  assertThrows(() => spec({ env: { "A=B": "c" } }));
});

Deno.test("secretEnv refuses names that configure the CLI", () => {
  for (const k of ["PATH", "HOME", "CONTAINER_X", "DYLD_X", "https_proxy"]) {
    assertThrows(() => spec({ secretEnv: { [k]: "x" } }), Error, undefined, k);
  }
  spec({ secretEnv: { PATHOLOGICAL: "x" } });
});

Deno.test("secretEnv is marked sensitive in both methods", () => {
  for (const m of ["ensure", "exec"] as const) {
    const field = model.methods[m].arguments.shape.secretEnv;
    assertEquals(z.globalRegistry.get(field)?.sensitive, true);
  }
});

Deno.test("spec hash: order-free, sensitive to changes, blind to secrets", async () => {
  const h = (o: Record<string, unknown>) => specHash(spec(o));
  assertEquals(
    await h({ env: { A: "1", B: "2" } }),
    await h({ env: { B: "2", A: "1" } }),
  );
  assert(await h({ cpus: 2 }) !== await h({ cpus: 4 }));
  assertEquals(
    await h({ secretEnv: { T: "1" } }),
    await h({ secretEnv: { T: "2" } }),
  );
  assert(await h({ secretEnv: { T: "1" } }) !== await h({}));
});

// --- ensure -----------------------------------------------------------------

Deno.test("ensure creates, then is a no-op, then restarts a stopped one", async () => {
  const cli = new Cli();
  const act = async () => (await run(cli, "ensure", SPEC))[0].data.action;
  assertEquals(await act(), "created");
  cli.calls = [];
  assertEquals(await act(), "unchanged");
  assertEquals(new Set(cli.verbs()), new Set(["list"]));
  cli.containers.get("web")!.state = "stopped";
  assertEquals(await act(), "started");
});

Deno.test("ensure passes secrets by environment and stores none", async () => {
  const cli = new Cli();
  const out = await run(cli, "ensure", {
    ...SPEC,
    secretEnv: { TOKEN: SECRET },
  });
  const create = cli.calls.find((c) => c.args[0] === "create")!;
  assertEquals(create.opts.env, { TOKEN: SECRET });
  assertFalse(JSON.stringify(cli.calls.map((c) => c.args)).includes(SECRET));
  assertFalse(JSON.stringify(out).includes(SECRET));
});

Deno.test("ensure refuses drift by default, replaces on request", async () => {
  const cli = new Cli();
  await run(cli, "ensure", SPEC);
  const changed = { ...SPEC, cpus: 2 };
  await assertRejects(() => run(cli, "ensure", changed), Error, "differs");
  const [w] = await run(cli, "ensure", { ...changed, replace: "drift" });
  assertEquals(w.data.action, "replaced");
  const [again] = await run(cli, "ensure", { ...changed, replace: "drift" });
  assertEquals(again.data.action, "unchanged");
  const [forced] = await run(cli, "ensure", { ...changed, replace: "always" });
  assertEquals(forced.data.action, "replaced");
});

Deno.test("ensure never touches a container it did not create", async () => {
  const cli = new Cli();
  cli.containers.set("web", { state: "running" });
  await assertRejects(
    () => run(cli, "ensure", { ...SPEC, replace: "always" }),
    Error,
    "not created by this model",
  );
  assertEquals(cli.verbs(), ["list"]);
});

Deno.test("ensure fails when the container dies after start", async () => {
  const cli = new Cli();
  cli.crashOnStart = true;
  await assertRejects(() => run(cli, "ensure", SPEC), Error, "stopped");
});

Deno.test("a CLI error redacts secrets", async () => {
  const cli = new Cli();
  const answer = cli.answer.bind(cli);
  cli.answer = (a) =>
    a[0] === "create"
      ? { code: 1, stdout: "", stderr: `bad ${SECRET}` }
      : answer(a);
  const e = await assertRejects(
    () => run(cli, "ensure", { ...SPEC, secretEnv: { T: SECRET } }),
    Error,
  );
  assertStringIncludes(e.message, "bad ***");
});

// --- stop, remove, prune ------------------------------------------------------

Deno.test("stop is idempotent and fails on an absent container", async () => {
  const cli = new Cli();
  await run(cli, "ensure", SPEC);
  assertEquals((await run(cli, "stop", { name: "web" }))[0].data.changed, true);
  assertEquals(
    (await run(cli, "stop", { name: "web" }))[0].data.changed,
    false,
  );
  await assertRejects(() => run(cli, "stop", { name: "nope" }));
});

Deno.test("remove guards running and unmanaged containers", async () => {
  const cli = new Cli();
  await run(cli, "ensure", SPEC);
  cli.containers.set("other", { state: "stopped" });
  await assertRejects(() => run(cli, "remove", { name: "web" }));
  await assertRejects(() => run(cli, "remove", { name: "other" }));
  await run(cli, "remove", { name: "web", force: true });
  await run(cli, "remove", { name: "other", allowUnmanaged: true });
  assertEquals(cli.containers.size, 0);
  const [w] = await run(cli, "remove", { name: "web" });
  assertEquals(w.data.action, "absent");
});

Deno.test("prune is a dry run by default and skips running and unmanaged", async () => {
  const cli = new Cli();
  cli.containers.set("old", { state: "stopped", hash: "h" });
  cli.containers.set("up", { state: "running", hash: "h" });
  cli.containers.set("other", { state: "stopped" });
  const [dry] = await run(cli, "pruneContainers");
  assertEquals(dry.data.candidates, ["old"]);
  assertEquals(cli.containers.size, 3);
  await run(cli, "pruneContainers", { apply: true });
  assertEquals([...cli.containers.keys()].sort(), ["other", "up"]);
  assert(cli.calls.every((c) => !c.args.includes("--force")));
});

Deno.test("prune reports a failed delete", async () => {
  const cli = new Cli();
  cli.containers.set("old", { state: "stopped", hash: "h" });
  cli.failDelete.add("old");
  await assertRejects(() => run(cli, "pruneContainers", { apply: true }));
});

// --- exec, logs, stats --------------------------------------------------------

Deno.test("exec redacts, and fails unless allowFailure", async () => {
  const cli = new Cli();
  await run(cli, "ensure", SPEC);
  cli.execResult = { code: 3, stdout: `got ${SECRET}`, stderr: "" };
  const input = {
    name: "web",
    command: ["id"],
    secretEnv: { T: SECRET },
  };
  await assertRejects(() => run(cli, "exec", input), Error, "exited 3");
  const [w] = await run(cli, "exec", { ...input, allowFailure: true });
  assertEquals(w.data.exitCode, 3);
  assertEquals(w.data.stdout, "got ***");
});

Deno.test("allowFailure does not hide a missing container", async () => {
  await assertRejects(
    () =>
      run(new Cli(), "exec", {
        name: "web",
        command: ["id"],
        allowFailure: true,
      }),
    Error,
    "absent",
  );
});

Deno.test("logs and stats", async () => {
  const cli = new Cli();
  const logs = async (lines: number) =>
    (await run(cli, "logs", { name: "web", lines }))[0].data;
  assertEquals((await logs(1)).stdout, "line");
  assertEquals((await logs(1)).truncated, false);
  cli.logText = "a\nb\nc\n";
  assertEquals((await logs(2)).stdout, "b\nc");
  assertEquals((await logs(2)).truncated, true);
  const [s] = await run(cli, "stats");
  assertEquals(
    (s.data.containers as { cpuCores: number }[])[0].cpuCores,
    0.5,
  );
});

Deno.test("the pre-flight check refuses another program or none", async () => {
  const check = model.checks["container-cli-runs"].execute;
  const ctx = { globalArgs: model.globalArguments.parse({}) };
  for (
    const [stdout, pass] of [
      ["container CLI version 1.7.1 (build: release)", true],
      ["some other container", false],
    ] as const
  ) {
    const restore = setRunner(() =>
      Promise.resolve({ code: 0, stdout, stderr: "" })
    );
    assertEquals((await check(ctx)).pass, pass);
    restore();
  }
  const restore = setRunner(() => Promise.reject(new Error("not found")));
  assertEquals((await check(ctx)).errors, ["not found"]);
  restore();
});

// --- service, volumes, inventory ------------------------------------------------

Deno.test("status records a stopped service; sync refuses to guess", async () => {
  const cli = new Cli();
  cli.service = false;
  const [w] = await run(cli, "status");
  assertEquals(w.data.running, false);
  await assertRejects(() => run(cli, "sync"), Error, "XPC");
});

Deno.test("systemStart never prompts; systemStop guards containers", async () => {
  const cli = new Cli();
  cli.service = false;
  await run(cli, "systemStart");
  assert(
    cli.calls.some((c) => c.args.includes("--enable-kernel-install")),
  );
  await run(cli, "ensure", SPEC);
  await assertRejects(() => run(cli, "systemStop"), Error, "web");
  await run(cli, "systemStop", { force: true });
  assertFalse(cli.service);
});

Deno.test("volumes: create once, delete only when confirmed", async () => {
  const cli = new Cli();
  await run(cli, "ensureVolume", { name: "data", size: "1G" });
  const [again] = await run(cli, "ensureVolume", { name: "data" });
  assertEquals(again.data.changed, false);
  await assertRejects(() =>
    run(cli, "removeVolume", { name: "data", confirm: "x" })
  );
  assertEquals(cli.volumes.size, 1);
  await run(cli, "removeVolume", { name: "data", confirm: "data" });
  assertEquals(cli.volumes.size, 0);
});

Deno.test("sync writes a schema-valid inventory", async () => {
  const cli = new Cli();
  await run(cli, "ensure", SPEC);
  const [w] = await run(cli, "sync");
  assertEquals(w.data.running, 1);
});

// --- the real CLI's parser -----------------------------------------------------

// Opt in with APPLE_CONTAINER_BIN, and only while the service is stopped: a
// valid command then fails on the missing service (exit 1) having changed
// nothing, and an invalid option fails earlier (exit 64). `--help` is no use
// here, since it exits 0 whatever the other options are.
const REAL = Deno.env.get("APPLE_CONTAINER_BIN");
Deno.test({
  name: "the real CLI accepts every option",
  ignore: !REAL,
  fn: async () => {
    const exit = async (args: string[]) =>
      (await new Deno.Command(REAL!, {
        args,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output()).code;
    assert(
      await exit(["system", "status"]) !== 0,
      "stop the container service before running this test",
    );
    assertEquals(await exit(["create", "--restart=always", "alpine"]), 64);

    const full = createArgs(
      spec({
        command: ["-c", "id"],
        entrypoint: "/bin/sh",
        env: { A: "-x" },
        secretEnv: { T: "t" },
        ports: ["127.0.0.1:8080:80"],
        volumes: ["v:/d"],
        networks: ["default"],
        cpus: 1,
        memory: "512M",
        platform: "linux/arm64",
        user: "1000",
        workdir: "/",
        init: true,
        readOnly: true,
        capAdd: ["NET_RAW"],
        capDrop: ["ALL"],
      }),
      "h",
    );
    for (
      const args of [
        full,
        ["list", "--all", "--format=json"],
        ["start", "web"],
        ["stop", "--time=5", "web"],
        ["delete", "web"],
        ["exec", "--env=T", "--user=0", "--workdir=/", "web", "ls", "-la"],
        ["logs", "-n", "5", "--boot", "web"],
        ["stats", "--no-stream", "--format=json", "web"],
        ["image", "list", "--format=json"],
        ["image", "pull", "--progress=plain", "--platform=linux/arm64", "a"],
        ["network", "list", "--format=json"],
        ["network", "create", "--internal", "--subnet=192.0.2.0/24", "n"],
        ["network", "delete", "n"],
        ["volume", "list", "--format=json"],
        ["volume", "create", "-s", "1G", "v"],
        ["volume", "delete", "v"],
        ["system", "df", "--format=json"],
      ]
    ) {
      assertEquals(await exit(args), 1, args.join(" "));
    }
  },
});
