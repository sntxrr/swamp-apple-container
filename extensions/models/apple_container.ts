/**
 * Apple container — drive Apple's `container` CLI
 * (https://github.com/apple/container) on the Mac that runs swamp: inventory,
 * desired-state containers, volumes, networks, exec, logs, stats and the
 * service itself.
 *
 * Three rules shape this model:
 *
 * - **Environment and command lines never leave the host.** `container list`
 *   and `container inspect` print `initProcess`, which holds every
 *   environment variable and argument. Each record here is rebuilt from named
 *   fields, so neither those nor label values are stored.
 * - **Secrets stay out of argv.** `secretEnv` values reach the CLI through its
 *   own environment (`--env=NAME`, no value), never on a command line.
 * - **Nothing is replaced or deleted by accident.** `ensure` refuses to touch
 *   a container it did not create, and replaces a drifted one only on request.
 *   Pruning is a dry run unless told otherwise and never touches volumes.
 *
 * Image build, push and registry login are left to `@swamp/container-image`,
 * which supports Apple's CLI.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Label holding the hash of the spec that created a container. */
export const SPEC_LABEL = "swamp.apple-container.spec";

/** Label marking the stopped copy `ensure` creates to validate a replacement. */
export const STAGING_LABEL = "swamp.apple-container.staging";

const MAX_OUTPUT = 64 * 1024;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/;
const VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const NETWORK_RE = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names the CLI itself reads; passing them by inheritance would alter it. */
const RESERVED_ENV_RE =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|SSH_AUTH_SOCK|CONTAINER_.*|DYLD_.*|XDG_.*|.*_PROXY|.*_proxy)$/;

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/** Result of one CLI invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Options for one CLI invocation. */
export interface RunOptions {
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** The seam tests replace: runs the CLI with an argument list. */
export type Runner = (
  binary: string,
  args: string[],
  opts: RunOptions,
) => Promise<RunResult>;

/** A call that was stopped before it finished. */
export class Interrupted extends Error {
  /** `true` when the CLI ended on SIGTERM, which it forwards to the command. */
  readonly graceful: boolean;
  /** Build the error from what stopped the call and how it ended. */
  constructor(message: string, graceful: boolean) {
    super(message);
    this.name = "Interrupted";
    this.graceful = graceful;
  }
}

const KILL_GRACE_MS = 5_000;

/**
 * Run the real CLI. No shell is involved. On timeout or cancellation it gets
 * SIGTERM, which it forwards to the command it runs, then SIGKILL.
 */
export const spawnRunner: Runner = async (binary, args, opts) => {
  opts.signal?.throwIfAborted();
  let child: Deno.ChildProcess;
  try {
    // swamp-quality-ignore deno-command
    child = new Deno.Command(binary, {
      args,
      env: opts.env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `'${binary}' not found. Install Apple's container CLI ` +
          "(brew install container) or set the `binary` global argument.",
      );
    }
    throw error;
  }
  let why = "";
  let killed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (sig: Deno.Signal) => {
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  const interrupt = (reason: string) => {
    if (why) return;
    why = reason;
    send("SIGTERM");
    killTimer = setTimeout(() => {
      killed = true;
      send("SIGKILL");
    }, KILL_GRACE_MS);
  };
  const timer = setTimeout(
    () => interrupt(`timed out after ${opts.timeoutMs} ms`),
    opts.timeoutMs,
  );
  const onAbort = () => interrupt("was cancelled");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const out = await child.output();
    if (why) throw new Interrupted(`container ${args[0]} ${why}`, !killed);
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
};

let runner: Runner = spawnRunner;

/** Replace the runner, for tests. Returns a function that restores it. */
export function setRunner(next: Runner): () => void {
  const previous = runner;
  runner = next;
  return () => {
    runner = previous;
  };
}

/** Replace each secret value with `***`, longest first. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.replaceAll(s, "***");
  }
  return out;
}

/** Keep the last `max` characters, reporting whether anything was cut. */
export function tail(
  text: string,
  max: number = MAX_OUTPUT,
): { text: string; truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(-max), truncated: true };
}

// ---------------------------------------------------------------------------
// Parsing. Every record is rebuilt from named fields.
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Raw : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const num = (v: unknown): number | null => typeof v === "number" ? v : null;

/** Parse CLI output as a JSON array of objects, or throw. Never guesses. */
export function parseArray(stdout: string, what: string): Raw[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`container ${what}: output is not JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`container ${what}: expected a JSON array`);
  }
  return parsed.map((row) => {
    const r = obj(row);
    if (typeof r.id !== "string" || r.id === "") {
      throw new Error(`container ${what}: a row has no id`);
    }
    return r;
  });
}

/** One container, without environment, arguments or label values. */
export interface ContainerRow {
  id: string;
  image: string | null;
  state: string;
  managed: boolean;
  specHash: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  ports: {
    hostAddress: string | null;
    hostPort: number | null;
    containerPort: number | null;
    protocol: string | null;
    count: number;
  }[];
  mounts: { destination: string | null; readOnly: boolean }[];
  addresses: { network: string | null; ipv4: string | null }[];
  createdAt: string | null;
  startedAt: string | null;
}

/** Parse `container list --format=json`. */
export function parseContainers(stdout: string): ContainerRow[] {
  return parseArray(stdout, "list").map((r) => {
    const c = obj(r.configuration);
    const s = obj(r.status);
    const res = obj(c.resources);
    const specHash = str(obj(c.labels)[SPEC_LABEL]);
    return {
      id: r.id as string,
      image: str(obj(c.image).reference),
      state: str(s.state) ?? "unknown",
      managed: specHash !== null,
      specHash,
      cpus: num(res.cpus),
      memoryBytes: num(res.memoryInBytes),
      ports: arr(c.publishedPorts).map(obj).map((p) => ({
        hostAddress: str(p.hostAddress),
        hostPort: num(p.hostPort),
        containerPort: num(p.containerPort),
        protocol: str(p.proto),
        count: num(p.count) ?? 1,
      })),
      mounts: arr(c.mounts).map(obj).map((m) => ({
        destination: str(m.destination),
        readOnly: arr(m.options).includes("ro"),
      })),
      addresses: arr(s.networks).map(obj).map((n) => ({
        network: str(n.network),
        ipv4: str(n.ipv4Address),
      })),
      createdAt: str(c.creationDate),
      startedAt: str(s.startedDate),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Whether a container's secret environment differs from what is wanted.
 * Compared in memory: neither side is returned, hashed or stored.
 */
export function secretsDiffer(
  stdout: string,
  id: string,
  want: Record<string, string>,
): boolean {
  const r = parseArray(stdout, "list").find((x) => x.id === id);
  const env = obj(obj(obj(r).configuration).initProcess).environment;
  if (!Array.isArray(env)) {
    throw new Error(`container list: ${id} has no environment`);
  }
  const have = new Set(env);
  return Object.entries(want).some(([k, v]) => !have.has(`${k}=${v}`));
}

/** The container a staging copy belongs to, or null when it is not one. */
export function stagingFor(stdout: string, id: string): string | null {
  const r = parseArray(stdout, "list").find((x) => x.id === id);
  return str(obj(obj(obj(r).configuration).labels)[STAGING_LABEL]);
}

/** Parse `container image list --format=json`. */
export function parseImages(stdout: string) {
  return parseArray(stdout, "image list").map((r) => {
    const c = obj(r.configuration);
    return {
      reference: str(c.name),
      digest: str(obj(c.descriptor).digest),
      createdAt: str(c.creationDate),
      platforms: arr(r.variants).map(obj).flatMap((v) => {
        const p = obj(v.platform);
        if (!str(p.os) || p.os === "unknown") return [];
        return [{
          platform: [p.os, p.architecture, p.variant].filter((x) =>
            typeof x === "string" && x
          ).join("/"),
          sizeBytes: num(v.size),
        }];
      }),
    };
  });
}

/** Parse `container volume list --format=json`. */
export function parseVolumes(stdout: string) {
  return parseArray(stdout, "volume list").map((r) => {
    const c = obj(r.configuration);
    return {
      name: r.id as string,
      driver: str(c.driver),
      format: str(c.format),
      sizeBytes: num(c.sizeInBytes),
      anonymous: "com.apple.container.resource.anonymous" in obj(c.labels),
      createdAt: str(c.creationDate),
    };
  });
}

/** Parse `container network list --format=json`. */
export function parseNetworks(stdout: string) {
  return parseArray(stdout, "network list").map((r) => {
    const c = obj(r.configuration);
    const s = obj(r.status);
    return {
      name: r.id as string,
      mode: str(c.mode),
      ipv4Subnet: str(s.ipv4Subnet) ?? str(c.ipv4Subnet),
      ipv4Gateway: str(s.ipv4Gateway),
      createdAt: str(c.creationDate),
    };
  });
}

/** Parse `container system df --format=json`. */
export function parseDiskUsage(stdout: string) {
  let parsed: Raw;
  try {
    parsed = obj(JSON.parse(stdout));
  } catch {
    throw new Error("container system df: output is not JSON");
  }
  const usage = (key: string) => {
    const u = obj(parsed[key]);
    const need = (field: string): number => {
      const v = num(u[field]);
      if (v === null) {
        throw new Error(`container system df: no ${key}.${field}`);
      }
      return v;
    };
    return {
      total: need("total"),
      active: need("active"),
      sizeBytes: need("sizeInBytes"),
      reclaimableBytes: need("reclaimable"),
    };
  };
  return {
    images: usage("images"),
    containers: usage("containers"),
    volumes: usage("volumes"),
  };
}

/** Parse `container stats --format=json`. */
export function parseStats(stdout: string) {
  return parseArray(stdout, "stats").map((r) => ({
    id: r.id as string,
    cpuCores: num(r.cpuUtilization),
    memoryUsageBytes: num(r.memoryUsageBytes),
    memoryLimitBytes: num(r.memoryLimitBytes),
    networkRxBytes: num(r.networkRxBytes),
    networkTxBytes: num(r.networkTxBytes),
    blockReadBytes: num(r.blockReadBytes),
    blockWriteBytes: num(r.blockWriteBytes),
    processes: num(r.numProcesses),
  }));
}

/** Parse `container system status --format=json`, running or not. */
export function parseStatus(stdout: string) {
  let r: Raw;
  try {
    r = obj(JSON.parse(stdout));
  } catch {
    throw new Error("container system status: output is not JSON");
  }
  const status = str(r.status);
  if (!status) throw new Error("container system status: no status field");
  return {
    status,
    running: status === "running",
    clientVersion: str(obj(r.client).version),
    serverVersion: str(obj(r.server).version),
  };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const line = z.string().min(1).regex(
  /^[^\n\r\0]+$/,
  "must not contain newlines or NUL",
);
const name = z.string().regex(NAME_RE, "not a valid container name");
const noNul = z.string().regex(/^[^\0]*$/, "must not contain NUL");

const SecretEnv = z.record(
  z.string().regex(ENV_RE).refine(
    (k) => !RESERVED_ENV_RE.test(k),
    "this name configures the CLI itself; use `env` instead",
  ),
  noNul,
).default({}).meta({ sensitive: true }).describe(
  "Secret environment. Passed through the CLI's environment, never argv.",
);

const SpecShape = {
  name: name.describe("Container name, which is also its ID."),
  image: z.string().regex(IMAGE_RE, "not an image reference").describe(
    "Image reference. Pin a digest to make a changed tag count as drift.",
  ),
  command: z.array(noNul).default([]).describe(
    "Arguments for the container's init process.",
  ),
  entrypoint: line.optional(),
  env: z.record(z.string().regex(ENV_RE), noNul).default({}).describe(
    "Non-secret environment. Visible in argv; use secretEnv for secrets.",
  ),
  secretEnv: SecretEnv,
  ports: z.array(line).default([]).describe(
    "[host-ip:]host-port:container-port[/protocol]",
  ),
  volumes: z.array(
    line.regex(/^[^:]+:./, "must be source:target; no anonymous volumes"),
  ).default([]).describe("source:target[:ro]"),
  networks: z.array(line).default([]).describe("name[,mac=..][,alias=..]"),
  cpus: z.number().int().positive().optional(),
  memory: z.string().regex(/^\d+[KMGTPkmgtp]?$/).optional().describe(
    "For example 512M or 2G.",
  ),
  platform: line.optional(),
  user: line.optional(),
  workdir: line.optional(),
  init: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  capDrop: z.array(line).default([]),
  capAdd: z.array(line).default([]),
};

const SpecSchema = z.object(SpecShape);

/** The desired state of one container. */
export type ContainerSpec = z.infer<typeof SpecSchema>;

function sortKeys(o: Record<string, string>): [string, string][] {
  return Object.entries(o).filter(([, v]) => v !== undefined).sort((
    [a],
    [b],
  ) => (a < b ? -1 : 1));
}

/**
 * SHA-256 of a spec. Secret names count and secret values do not: the hash is
 * stored in a readable label, where a guessable secret could be recovered.
 */
export async function specHash(spec: ContainerSpec): Promise<string> {
  const { secretEnv, env, ...rest } = spec;
  const canonical = JSON.stringify([
    sortKeys(rest as unknown as Record<string, string>),
    sortKeys(env),
    Object.keys(secretEnv).sort(),
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Arguments for `container create`. Options use the joined `--opt=value` form
 * so a value starting with `-` cannot be read as another option.
 */
export function createArgs(
  spec: ContainerSpec,
  hash: string,
  stagingName?: string,
): string[] {
  const a = [
    "create",
    `--name=${stagingName ?? spec.name}`,
    `--label=${SPEC_LABEL}=${hash}`,
  ];
  if (stagingName) a.push(`--label=${STAGING_LABEL}=${spec.name}`);
  for (const [k, v] of sortKeys(spec.env)) a.push(`--env=${k}=${v}`);
  for (const k of Object.keys(spec.secretEnv).sort()) a.push(`--env=${k}`);
  for (const p of spec.ports) a.push(`--publish=${p}`);
  for (const v of spec.volumes) a.push(`--volume=${v}`);
  for (const n of spec.networks) a.push(`--network=${n}`);
  for (const c of spec.capDrop) a.push(`--cap-drop=${c}`);
  for (const c of spec.capAdd) a.push(`--cap-add=${c}`);
  if (spec.cpus !== undefined) a.push(`--cpus=${spec.cpus}`);
  if (spec.memory) a.push(`--memory=${spec.memory}`);
  if (spec.platform) a.push(`--platform=${spec.platform}`);
  if (spec.user) a.push(`--user=${spec.user}`);
  if (spec.workdir) a.push(`--workdir=${spec.workdir}`);
  if (spec.entrypoint) a.push(`--entrypoint=${spec.entrypoint}`);
  if (spec.init) a.push("--init");
  if (spec.readOnly) a.push("--read-only");
  a.push(spec.image, ...spec.command);
  return a;
}

const GlobalArgsSchema = z.object({
  binary: line.default("container").describe(
    "Path to Apple's container CLI. Set an absolute path, such as " +
      "/opt/homebrew/bin/container, when PATH is minimal (launchd, cron).",
  ),
  timeoutMs: z.number().int().positive().default(120_000).describe(
    "Limit for each CLI call. Image pulls use pullTimeoutMs.",
  ),
  pullTimeoutMs: z.number().int().positive().default(900_000).describe(
    "Limit for calls that may download an image or kernel.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface Context {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    spec: string,
    instance: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

interface CallOptions {
  secrets?: Record<string, string>;
  slow?: boolean;
}

function raw(ctx: Context, args: string[], o: CallOptions = {}) {
  const g = ctx.globalArgs;
  return runner(g.binary, args, {
    env: o.secrets,
    signal: ctx.signal,
    timeoutMs: o.slow ? g.pullTimeoutMs : g.timeoutMs,
  });
}

async function must(
  ctx: Context,
  args: string[],
  o: CallOptions = {},
): Promise<string> {
  const r = await raw(ctx, args, o);
  if (r.code !== 0) {
    const verb = args.slice(0, 2).filter((a) => !a.startsWith("-")).join(" ");
    const detail = redact(
      r.stderr.trim(),
      Object.values(o.secrets ?? {}),
    ).slice(-600);
    throw new Error(`container ${verb} failed (exit ${r.code}): ${detail}`);
  }
  return r.stdout;
}

const listRaw = (ctx: Context) => must(ctx, ["list", "--all", "--format=json"]);
const listAll = async (ctx: Context) => parseContainers(await listRaw(ctx));

async function find(ctx: Context, id: string): Promise<ContainerRow | null> {
  return (await listAll(ctx)).find((c) => c.id === id) ?? null;
}

const volumes = async (ctx: Context) =>
  parseVolumes(await must(ctx, ["volume", "list", "--format=json"]));
const networks = async (ctx: Context) =>
  parseNetworks(await must(ctx, ["network", "list", "--format=json"]));

const now = () => new Date().toISOString();

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function stopIfUp(ctx: Context, row: ContainerRow, seconds: number) {
  if (row.state === "stopped") return false;
  await must(ctx, ["stop", `--time=${seconds}`, row.id]);
  const after = await find(ctx, row.id);
  if (after && after.state !== "stopped") {
    throw new Error(`${row.id} is still '${after.state}' after stop`);
  }
  return true;
}

async function deleteRow(ctx: Context, id: string) {
  await must(ctx, ["delete", id]);
  if (await find(ctx, id)) throw new Error(`${id} still exists after delete`);
}

/** Data instance name for an image: readable, and unique per reference. */
export async function imageInstance(image: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image)),
  );
  const hex = [...digest.slice(0, 6)].map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${image.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)}-${hex}`;
}

/** Name of the staging copy: within the CLI's 63 characters, and stable. */
export function stagingName(id: string): string {
  return `${id.slice(0, 50)}.swampstage`;
}

/**
 * Prove a replacement can be created, image and all, while the container it
 * will replace still exists. The CLI cannot rename, so the copy is deleted.
 */
async function rehearse(ctx: Context, spec: ContainerSpec, hash: string) {
  const id = stagingName(spec.name);
  const clear = async () => {
    const out = await listRaw(ctx);
    const row = parseContainers(out).find((c) => c.id === id);
    if (!row) return;
    if (stagingFor(out, id) !== spec.name || row.state !== "stopped") {
      throw new Error(`${id} exists and is not a stopped staging copy`);
    }
    await deleteRow(ctx, id);
  };
  await clear(); // left by an interrupted run
  await must(ctx, createArgs(spec, hash, id), {
    secrets: spec.secretEnv,
    slow: true,
  });
  await clear();
}

/**
 * Whether a failed `container exec` is the CLI's own failure to start the
 * command, rather than the command exiting non-zero.
 */
export function isExecCliError(r: RunResult): boolean {
  return (r.code === 1 &&
    /^Error: failed to start process [0-9a-f-]{36} in container /m.test(
      r.stderr,
    )) || (r.code === 64 && r.stderr.includes("Usage: container exec"));
}

const EXEC_ID = "SWAMP_EXEC_ID";
/** Kills every process carrying the marker; prints how many remain. */
const REAP = "for s in 1 2 3; do n=0; for p in /proc/[0-9]*; do " +
  'if grep -q "$1" "$p/environ" 2>/dev/null && kill -9 "${p#/proc/}" 2>/dev/null; ' +
  "then n=$((n+1)); fi; done; [ $n = 0 ] && break; sleep 1; done; echo left=$n";

/** Stop what a forcibly ended exec left behind, and say whether that worked. */
async function reap(ctx: Context, id: string, marker: string): Promise<string> {
  try {
    // Not the run's signal: it may be the reason we are here.
    const r = await runner(
      ctx.globalArgs.binary,
      ["exec", "--user=0", id, "sh", "-c", REAP, "sh", `${EXEC_ID}=${marker}`],
      { timeoutMs: 20_000 },
    );
    if (r.code === 0 && r.stdout.trim() === "left=0") {
      return "the command ignored SIGTERM and was killed";
    }
  } catch {
    // Reported below.
  }
  return `the command ignored SIGTERM and could not be killed; it may still run in ${id}. Stop the container to end it`;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const ContainerSchema = z.object({
  id: z.string(),
  image: z.string().nullable(),
  state: z.string(),
  managed: z.boolean(),
  specHash: z.string().nullable(),
  cpus: z.number().nullable(),
  memoryBytes: z.number().nullable(),
  ports: z.array(z.object({
    hostAddress: z.string().nullable(),
    hostPort: z.number().nullable(),
    containerPort: z.number().nullable(),
    protocol: z.string().nullable(),
    count: z.number(),
  })),
  mounts: z.array(
    z.object({ destination: z.string().nullable(), readOnly: z.boolean() }),
  ),
  addresses: z.array(
    z.object({ network: z.string().nullable(), ipv4: z.string().nullable() }),
  ),
  createdAt: z.string().nullable(),
  startedAt: z.string().nullable(),
});

const UsageSchema = z.object({
  total: z.number(),
  active: z.number(),
  sizeBytes: z.number(),
  reclaimableBytes: z.number(),
});

const nullableText = z.string().nullable();
const nullableNum = z.number().nullable();

const InventorySchema = z.object({
  containers: z.array(ContainerSchema),
  running: z.number(),
  images: z.array(z.object({
    reference: nullableText,
    digest: nullableText,
    createdAt: nullableText,
    platforms: z.array(
      z.object({ platform: z.string(), sizeBytes: nullableNum }),
    ),
  })),
  volumes: z.array(z.object({
    name: z.string(),
    driver: nullableText,
    format: nullableText,
    sizeBytes: nullableNum,
    anonymous: z.boolean(),
    createdAt: nullableText,
  })),
  networks: z.array(z.object({
    name: z.string(),
    mode: nullableText,
    ipv4Subnet: nullableText,
    ipv4Gateway: nullableText,
    createdAt: nullableText,
  })),
  diskUsage: z.object({
    images: UsageSchema,
    containers: UsageSchema,
    volumes: UsageSchema,
  }),
  timestamp: z.string(),
});

const ActionSchema = z.object({
  kind: z.string(),
  name: z.string(),
  action: z.string(),
  changed: z.boolean(),
  container: ContainerSchema.nullable(),
  timestamp: z.string(),
});

const StatusSchema = z.object({
  status: z.string(),
  running: z.boolean(),
  clientVersion: nullableText,
  serverVersion: nullableText,
  timestamp: z.string(),
});

const StatsSchema = z.object({
  containers: z.array(z.object({
    id: z.string(),
    cpuCores: nullableNum,
    memoryUsageBytes: nullableNum,
    memoryLimitBytes: nullableNum,
    networkRxBytes: nullableNum,
    networkTxBytes: nullableNum,
    blockReadBytes: nullableNum,
    blockWriteBytes: nullableNum,
    processes: nullableNum,
  })),
  timestamp: z.string(),
});

const OutputSchema = z.object({
  name: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timestamp: z.string(),
});

const PruneSchema = z.object({
  dryRun: z.boolean(),
  candidates: z.array(z.string()),
  deleted: z.array(z.string()),
  timestamp: z.string(),
});

const persistent = (description: string, schema: z.ZodType) => ({
  description,
  schema,
  lifetime: "infinite" as const,
  garbageCollection: 20,
});

async function record(
  ctx: Context,
  kind: string,
  id: string,
  action: string,
  changed: boolean,
  container: ContainerRow | null = null,
) {
  ctx.logger.info("{kind} {name}: {action}", { kind, name: id, action });
  await ctx.writeResource("action", `${kind}-${id}`, {
    kind,
    name: id,
    action,
    changed,
    container,
    timestamp: now(),
  });
}

async function readStatus(ctx: Context) {
  // Exit 1 with a JSON body is the CLI's answer for "not running".
  const r = await raw(ctx, ["system", "status", "--format=json"]);
  if (r.code !== 0 && r.stdout.trim() === "") {
    throw new Error(
      `container system status failed (exit ${r.code}): ${
        r.stderr.trim().slice(-600)
      }`,
    );
  }
  return { ...parseStatus(r.stdout), timestamp: now() };
}

/** swamp allows one write per instance per run, so this comes last. */
async function writeStatus(ctx: Context) {
  const status = await readStatus(ctx);
  await ctx.writeResource("status", "status", status);
  return status;
}

type Execute<A> = (
  args: A,
  ctx: Context,
) => Promise<{ dataHandles: unknown[] }>;

/** Return the handle of every resource a method wrote, as swamp requires. */
function collect<A>(
  method: string,
  body: (args: A, ctx: Context) => Promise<void>,
): Execute<A> {
  return async (args, ctx) => {
    const dataHandles: unknown[] = [];
    ctx.logger.info("{method}: starting", { method });
    await body(args, {
      globalArgs: ctx.globalArgs,
      signal: ctx.signal,
      logger: ctx.logger,
      writeResource: async (spec, instance, data) => {
        const handle = await ctx.writeResource(spec, instance, data);
        dataHandles.push(handle);
        return handle;
      },
    });
    ctx.logger.info("{method}: done, {count} records", {
      method,
      count: dataHandles.length,
    });
    return { dataHandles };
  };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const stopSeconds = z.number().int().nonnegative().max(600).default(5)
  .describe("Grace period before SIGKILL.");

/** The `@sntxrr/apple-container` model. */
export const model = {
  type: "@sntxrr/apple-container",
  description:
    "Manage containers on this Mac with Apple's container CLI: inventory, desired-state containers, volumes, networks, exec, logs, stats and the service. Stores no environment, arguments or label values.",
  version: "2026.11.24.1",
  globalArguments: GlobalArgsSchema,
  checks: {
    "container-cli-runs": {
      description:
        "Apple's container CLI must start and identify itself, so another program of that name is never driven.",
      labels: ["live"],
      execute: async (
        ctx: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const binary = ctx.globalArgs.binary;
        try {
          const r = await runner(binary, ["--version"], { timeoutMs: 10_000 });
          if (r.code === 0 && r.stdout.startsWith("container CLI version")) {
            return { pass: true };
          }
          return {
            pass: false,
            errors: [`${binary} is not Apple's container CLI`],
          };
        } catch (error) {
          return {
            pass: false,
            errors: [error instanceof Error ? error.message : String(error)],
          };
        }
      },
    },
  },
  resources: {
    status: persistent("Whether the service runs, and versions.", StatusSchema),
    inventory: persistent(
      "Containers, images, volumes, networks and disk usage.",
      InventorySchema,
    ),
    action: persistent("Outcome of one change to one object.", ActionSchema),
    stats: persistent("One resource-usage sample.", StatsSchema),
    output: {
      ...persistent("Captured output of exec or logs.", OutputSchema),
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    prune: persistent("Plan or result of a prune.", PruneSchema),
  },
  methods: {
    status: {
      description:
        "Read-only. Report whether the container service is running. A stopped service is a result, not an error.",
      arguments: z.object({}),
      execute: collect(
        "status",
        async (_args: Record<string, never>, ctx: Context) => {
          await writeStatus(ctx);
        },
      ),
    },
    systemStart: {
      description:
        "Start the container service and prove it is running. Never prompts.",
      arguments: z.object({
        installKernel: z.boolean().default(true).describe(
          "Download the default Linux kernel if none is installed.",
        ),
      }),
      execute: collect(
        "systemStart",
        async (args: { installKernel: boolean }, ctx: Context) => {
          if ((await readStatus(ctx)).running) {
            await writeStatus(ctx);
            return;
          }
          await must(ctx, [
            "system",
            "start",
            args.installKernel
              ? "--enable-kernel-install"
              : "--disable-kernel-install",
          ], { slow: true });
          const after = await writeStatus(ctx);
          if (!after.running) {
            throw new Error(`service is '${after.status}' after system start`);
          }
        },
      ),
    },
    systemStop: {
      description:
        "Stop the container service, and with it every running container. Refuses while containers run unless force is set.",
      arguments: z.object({ force: z.boolean().default(false) }),
      execute: collect(
        "systemStop",
        async (args: { force: boolean }, ctx: Context) => {
          if (!(await readStatus(ctx)).running) {
            await writeStatus(ctx);
            return;
          }
          const up = (await listAll(ctx)).filter((c) => c.state !== "stopped");
          if (up.length && !args.force) {
            throw new Error(
              `refusing to stop the service: ${
                up.map((c) => c.id).join(", ")
              } not stopped. Set force to stop anyway.`,
            );
          }
          await must(ctx, ["system", "stop"]);
          const after = await writeStatus(ctx);
          if (after.running) throw new Error("service still runs after stop");
        },
      ),
    },
    sync: {
      description:
        "Read-only. Record every container, image, volume and network, plus disk usage.",
      arguments: z.object({}),
      execute: collect(
        "sync",
        async (_args: Record<string, never>, ctx: Context) => {
          const containers = await listAll(ctx);
          const inventory = {
            containers,
            running: containers.filter((c) => c.state === "running").length,
            images: parseImages(
              await must(ctx, ["image", "list", "--format=json"]),
            ),
            volumes: await volumes(ctx),
            networks: await networks(ctx),
            diskUsage: parseDiskUsage(
              await must(ctx, ["system", "df", "--format=json"]),
            ),
            timestamp: now(),
          };
          ctx.logger.info("{count} containers, {running} running", {
            count: containers.length,
            running: inventory.running,
          });
          await ctx.writeResource("inventory", "inventory", inventory);
        },
      ),
    },
    ensure: {
      description:
        "Create and start a container, or do nothing when it already matches. Refuses a container it did not create. A drifted one is replaced only when asked.",
      arguments: SpecSchema.extend({
        replace: z.enum(["never", "drift", "always"]).default("never").describe(
          "Whether to recreate a managed container: never, when its spec or a secret changed, or every time. The replacement is created once as a check before the old one is deleted.",
        ),
        settleSeconds: z.number().nonnegative().max(300).default(2).describe(
          "Wait this long after start, then require it still runs.",
        ),
        stopSeconds,
      }),
      execute: collect("ensure", async (
        args: ContainerSpec & {
          replace: "never" | "drift" | "always";
          settleSeconds: number;
          stopSeconds: number;
        },
        ctx: Context,
      ) => {
        const { replace, settleSeconds, stopSeconds, ...spec } = args;
        const hash = await specHash(spec);
        const listing = await listRaw(ctx);
        let row = parseContainers(listing).find((c) => c.id === spec.name) ??
          null;
        let action = "unchanged";
        if (row && !row.managed) {
          throw new Error(
            `${spec.name} exists and was not created by this model; not touching it`,
          );
        }
        const drifted = row !== null && (row.specHash !== hash ||
          secretsDiffer(listing, spec.name, spec.secretEnv));
        if (row && (drifted || replace === "always")) {
          if (replace === "never") {
            throw new Error(
              `${spec.name} differs from the requested spec. Set replace=drift to recreate it (its root filesystem is lost).`,
            );
          }
          await rehearse(ctx, spec, hash);
          await stopIfUp(ctx, row, stopSeconds);
          await deleteRow(ctx, spec.name);
          row = null;
          action = "replaced";
        }
        if (!row) {
          await must(ctx, createArgs(spec, hash), {
            secrets: spec.secretEnv,
            slow: true,
          });
          if (action === "unchanged") action = "created";
        }
        if (row?.state !== "running") {
          if (action === "unchanged") action = "started";
          await must(ctx, ["start", spec.name]);
          await sleep(settleSeconds * 1000, ctx.signal);
        }
        const after = await find(ctx, spec.name);
        if (after?.state !== "running") {
          throw new Error(
            `${spec.name} is '${
              after?.state ?? "absent"
            }' ${settleSeconds}s after start; run logs to see why`,
          );
        }
        await record(
          ctx,
          "container",
          spec.name,
          action,
          action !== "unchanged",
          after,
        );
      }),
    },
    stop: {
      description: "Stop a container. Already stopped is not an error.",
      arguments: z.object({ name, stopSeconds }),
      execute: collect("stop", async (
        args: { name: string; stopSeconds: number },
        ctx: Context,
      ) => {
        const row = await find(ctx, args.name);
        if (!row) throw new Error(`no such container: ${args.name}`);
        const changed = await stopIfUp(ctx, row, args.stopSeconds);
        await record(
          ctx,
          "container",
          args.name,
          changed ? "stopped" : "unchanged",
          changed,
          await find(ctx, args.name),
        );
      }),
    },
    remove: {
      description:
        "Delete a container. Absent is not an error. Refuses a running one unless force is set, and an unmanaged one unless allowUnmanaged is set.",
      arguments: z.object({
        name,
        force: z.boolean().default(false).describe("Stop it first."),
        allowUnmanaged: z.boolean().default(false),
        stopSeconds,
      }),
      execute: collect("remove", async (
        args: {
          name: string;
          force: boolean;
          allowUnmanaged: boolean;
          stopSeconds: number;
        },
        ctx: Context,
      ) => {
        const row = await find(ctx, args.name);
        if (row) {
          if (!row.managed && !args.allowUnmanaged) {
            throw new Error(
              `${args.name} was not created by this model; set allowUnmanaged to delete it`,
            );
          }
          if (row.state !== "stopped" && !args.force) {
            throw new Error(`${args.name} is ${row.state}; set force`);
          }
          await stopIfUp(ctx, row, args.stopSeconds);
          await deleteRow(ctx, args.name);
        }
        await record(
          ctx,
          "container",
          args.name,
          row ? "removed" : "absent",
          row !== null,
        );
      }),
    },
    exec: {
      description:
        "Run a command in a running container and store its output. Takes an argument list, not a shell string.",
      arguments: z.object({
        name,
        command: z.array(noNul).min(1),
        secretEnv: SecretEnv,
        user: line.optional(),
        workdir: line.optional(),
        allowFailure: z.boolean().default(false).describe(
          "Record a non-zero exit instead of failing.",
        ),
      }),
      execute: collect("exec", async (
        args: {
          name: string;
          command: string[];
          secretEnv: Record<string, string>;
          user?: string;
          workdir?: string;
          allowFailure: boolean;
        },
        ctx: Context,
      ) => {
        // Checked first so allowFailure cannot turn "no container" into a
        // recorded command result.
        const row = await find(ctx, args.name);
        if (row?.state !== "running") {
          throw new Error(`${args.name} is ${row?.state ?? "absent"}`);
        }
        const marker = crypto.randomUUID();
        const a = ["exec", `--env=${EXEC_ID}=${marker}`];
        for (const k of Object.keys(args.secretEnv).sort()) {
          a.push(`--env=${k}`);
        }
        if (args.user) a.push(`--user=${args.user}`);
        if (args.workdir) a.push(`--workdir=${args.workdir}`);
        a.push(args.name, ...args.command);
        const secrets = Object.values(args.secretEnv);
        let r: RunResult;
        try {
          r = await raw(ctx, a, { secrets: args.secretEnv });
        } catch (error) {
          if (error instanceof Interrupted && !error.graceful) {
            throw new Error(
              `${error.message}; ${await reap(ctx, args.name, marker)}`,
            );
          }
          throw error;
        }
        const out = tail(redact(r.stdout, secrets));
        const err = tail(redact(r.stderr, secrets));
        if (r.code !== 0) {
          const still = await find(ctx, args.name);
          if (isExecCliError(r) || still?.state !== "running") {
            throw new Error(
              `could not run the command in ${args.name} (${
                still?.state ?? "absent"
              }): ${err.text.trim().slice(0, 400)}`,
            );
          }
          if (!args.allowFailure) {
            throw new Error(
              `command in ${args.name} exited ${r.code}; set allowFailure to record it. stderr: ${
                err.text.trim().slice(-2000)
              } stdout: ${out.text.trim().slice(-2000)}`,
            );
          }
        }
        await ctx.writeResource("output", `exec-${args.name}`, {
          name: args.name,
          exitCode: r.code,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          timestamp: now(),
        });
      }),
    },
    logs: {
      description: "Read-only. Store the last lines of a container's log.",
      arguments: z.object({
        name,
        lines: z.number().int().positive().max(5000).default(200),
        boot: z.boolean().default(false).describe("The VM boot log instead."),
      }),
      execute: collect("logs", async (
        args: { name: string; lines: number; boot: boolean },
        ctx: Context,
      ) => {
        // One line over the limit tells a cut log from a complete one.
        const a = ["logs", "-n", String(args.lines + 1)];
        if (args.boot) a.push("--boot");
        a.push(args.name);
        const kept = (await must(ctx, a)).split("\n");
        if (kept[kept.length - 1] === "") kept.pop();
        const cut = kept.length > args.lines;
        const out = tail(kept.slice(-args.lines).join("\n"));
        await ctx.writeResource("output", `logs-${args.name}`, {
          name: args.name,
          exitCode: 0,
          stdout: out.text,
          stderr: "",
          truncated: cut || out.truncated,
          timestamp: now(),
        });
      }),
    },
    stats: {
      description:
        "Read-only. Sample CPU, memory, network and disk I/O. All running containers unless names are given.",
      arguments: z.object({ names: z.array(name).default([]) }),
      execute: collect(
        "stats",
        async (args: { names: string[] }, ctx: Context) => {
          const stdout = await must(ctx, [
            "stats",
            "--no-stream",
            "--format=json",
            ...args.names,
          ]);
          await ctx.writeResource("stats", "stats", {
            containers: parseStats(stdout),
            timestamp: now(),
          });
        },
      ),
    },
    pull: {
      description: "Pull an image.",
      arguments: z.object({
        image: SpecShape.image,
        platform: line.optional(),
      }),
      execute: collect("pull", async (
        args: { image: string; platform?: string },
        ctx: Context,
      ) => {
        const a = ["image", "pull", "--progress=plain"];
        if (args.platform) a.push(`--platform=${args.platform}`);
        await must(ctx, [...a, args.image], { slow: true });
        await record(
          ctx,
          "image",
          await imageInstance(args.image),
          "pulled",
          true,
        );
      }),
    },
    ensureVolume: {
      description:
        "Create a named volume if absent. Never resizes an existing one.",
      arguments: z.object({
        name: z.string().regex(VOLUME_RE),
        size: z.string().regex(/^\d+[KMGTPkmgtp]?$/).optional(),
      }),
      execute: collect(
        "ensureVolume",
        async (args: { name: string; size?: string }, ctx: Context) => {
          const has = async () =>
            (await volumes(ctx)).some((v) => v.name === args.name);
          const existed = await has();
          if (!existed) {
            const a = ["volume", "create"];
            if (args.size) a.push("-s", args.size);
            await must(ctx, [...a, args.name]);
            if (!await has()) {
              throw new Error(`volume ${args.name} missing after create`);
            }
          }
          await record(
            ctx,
            "volume",
            args.name,
            existed ? "unchanged" : "created",
            !existed,
          );
        },
      ),
    },
    removeVolume: {
      description:
        "Delete one named volume and its data. confirm must repeat the name. Absent is not an error.",
      arguments: z.object({
        name: z.string().regex(VOLUME_RE),
        confirm: z.string(),
      }),
      execute: collect("removeVolume", async (
        args: { name: string; confirm: string },
        ctx: Context,
      ) => {
        if (args.confirm !== args.name) {
          throw new Error("confirm must equal the volume name");
        }
        const has = async () =>
          (await volumes(ctx)).some((v) => v.name === args.name);
        const existed = await has();
        if (existed) {
          await must(ctx, ["volume", "delete", args.name]);
          if (await has()) {
            throw new Error(`volume ${args.name} exists after delete`);
          }
        }
        await record(
          ctx,
          "volume",
          args.name,
          existed ? "removed" : "absent",
          existed,
        );
      }),
    },
    ensureNetwork: {
      description: "Create a network if absent (macOS 26 or later).",
      arguments: z.object({
        name: z.string().regex(NETWORK_RE),
        subnet: line.optional(),
        internal: z.boolean().default(false),
      }),
      execute: collect("ensureNetwork", async (
        args: { name: string; subnet?: string; internal: boolean },
        ctx: Context,
      ) => {
        const has = async () =>
          (await networks(ctx)).some((n) => n.name === args.name);
        const existed = await has();
        if (!existed) {
          const a = ["network", "create"];
          if (args.internal) a.push("--internal");
          if (args.subnet) a.push(`--subnet=${args.subnet}`);
          await must(ctx, [...a, args.name]);
          if (!await has()) {
            throw new Error(`network ${args.name} missing after create`);
          }
        }
        await record(
          ctx,
          "network",
          args.name,
          existed ? "unchanged" : "created",
          !existed,
        );
      }),
    },
    removeNetwork: {
      description:
        "Delete one network. Absent is not an error; the CLI refuses one in use.",
      arguments: z.object({ name: z.string().regex(NETWORK_RE) }),
      execute: collect(
        "removeNetwork",
        async (args: { name: string }, ctx: Context) => {
          const has = async () =>
            (await networks(ctx)).some((n) => n.name === args.name);
          const existed = await has();
          if (existed) {
            await must(ctx, ["network", "delete", args.name]);
            if (await has()) {
              throw new Error(`network ${args.name} exists after delete`);
            }
          }
          await record(
            ctx,
            "network",
            args.name,
            existed ? "removed" : "absent",
            existed,
          );
        },
      ),
    },
    pruneContainers: {
      description:
        "Delete stopped containers this model created. A dry run unless apply is set. Never deletes images or volumes.",
      arguments: z.object({
        apply: z.boolean().default(false),
        includeUnmanaged: z.boolean().default(false),
      }),
      execute: collect("pruneContainers", async (
        args: { apply: boolean; includeUnmanaged: boolean },
        ctx: Context,
      ) => {
        const candidates = (await listAll(ctx)).filter((c) =>
          c.state === "stopped" && (c.managed || args.includeUnmanaged)
        ).map((c) => c.id);
        const deleted: string[] = [];
        const failed: { id: string; error: string }[] = [];
        for (const id of args.apply ? candidates : []) {
          try {
            // Without --force: one restarted since the listing is kept.
            await deleteRow(ctx, id);
            deleted.push(id);
          } catch (error) {
            failed.push({
              id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (failed.length) {
          throw new Error(
            `deleted [${deleted.join(", ")}]; could not delete ${
              failed.map((f) => `${f.id} (${f.error})`).join(", ")
            }`,
          );
        }
        await ctx.writeResource("prune", "containers", {
          dryRun: !args.apply,
          candidates,
          deleted,
          timestamp: now(),
        });
      }),
    },
  },
};
