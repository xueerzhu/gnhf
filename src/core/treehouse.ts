import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { appendDebugLog, serializeError } from "./debug-log.js";

// A leased treehouse pool clone: a real, independent git checkout on its own
// Unity QA port that gnhf runs inside instead of a git worktree. Unlike a
// worktree (which shares the main repo's object store and is invisible to a
// running Unity Editor), each clone is a full project an Editor can open and
// compile. See Tower Lab's scripts/treehouse.sh — the reference implementation
// of the get/heartbeat/return JSON contract this module shells out to.
export interface TreehouseLease {
  slot: number;
  path: string;
  port: number;
  token: string;
  ref: string;
}

export interface TreehouseGetOptions {
  branch: string;
  label: string;
  wait: boolean;
}

// 10 min, comfortably under treehouse's 30-min lease TTL, so a long-running
// gnhf loop is never reaped out from under itself.
export const TREEHOUSE_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

// Resolve the pool-control script. Override with GNHF_TREEHOUSE_SCRIPT; default
// to <repoRoot>/scripts/treehouse.sh (Tower Lab's layout). Kept generic on
// purpose: any repo providing a script with the same get/heartbeat/return
// contract can drive --treehouse.
export function resolveTreehouseScript(repoRoot: string): string {
  const override = process.env.GNHF_TREEHOUSE_SCRIPT?.trim();
  const scriptPath =
    override && override.length > 0
      ? override
      : join(repoRoot, "scripts", "treehouse.sh");
  if (!existsSync(scriptPath)) {
    throw new Error(
      `--treehouse needs a pool-control script exposing "get"/"heartbeat"/"return", ` +
        `but none was found at ${scriptPath}. Point GNHF_TREEHOUSE_SCRIPT at one ` +
        `(Tower Lab ships scripts/treehouse.sh), or run gnhf from the repo that provides it.`,
    );
  }
  return scriptPath;
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{") && entry.endsWith("}"))
    .pop();
  if (!line) {
    throw new Error(
      `treehouse returned no JSON result:\n${stdout.trim() || "(no output)"}`,
    );
  }
  return JSON.parse(line);
}

// Lease a clone. When opts.wait is set this blocks in the script's zero-token
// queue until a slot frees (excess concurrent agents queue rather than fail);
// otherwise it fails fast on an exhausted pool. The script cold-launches the
// clone's Unity Editor and only returns once it answers /api/health, so on a
// cold pool this can take a minute or two — its progress streams to stderr.
export function treehouseGet(
  scriptPath: string,
  repoRoot: string,
  opts: TreehouseGetOptions,
): TreehouseLease {
  const args = [scriptPath, "get", "--branch", opts.branch, "--label", opts.label];
  if (opts.wait) {
    args.push("--wait");
  }

  let stdout: string;
  try {
    stdout = execFileSync("bash", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      // stdout captured for the JSON result; stderr streamed live so the user
      // sees the cold-editor-start progress while this blocks.
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env },
    });
  } catch (error) {
    appendDebugLog("treehouse:get:failed", { error: serializeError(error) });
    const status = (error as { status?: number }).status;
    throw new Error(
      `treehouse get failed (exit ${status ?? "?"}). Is the pool provisioned and healthy? ` +
        `Check: ${scriptPath} status`,
    );
  }

  const parsed = lastJsonLine(stdout) as {
    leased?: boolean;
    slot?: number;
    path?: string;
    port?: number;
    token?: string;
    ref?: string;
    reason?: string;
  };
  if (
    !parsed.leased ||
    parsed.slot === undefined ||
    !parsed.path ||
    parsed.port === undefined ||
    !parsed.token
  ) {
    throw new Error(
      `treehouse did not lease a clone${parsed.reason ? ` (${parsed.reason})` : ""}. ` +
        `Inspect the pool with: ${scriptPath} status`,
    );
  }

  return {
    slot: parsed.slot,
    path: parsed.path,
    port: parsed.port,
    token: parsed.token,
    ref: parsed.ref ?? opts.branch,
  };
}

// Fire-and-forget heartbeat. Deliberately never throws: a transient miss is
// harmless because the lease only expires after a full TTL of *no* heartbeats.
export function treehouseHeartbeat(
  scriptPath: string,
  repoRoot: string,
  token: string,
): void {
  execFile(
    "bash",
    [scriptPath, "heartbeat", token],
    { cwd: repoRoot, env: { ...process.env } },
    (error) => {
      if (error) {
        appendDebugLog("treehouse:heartbeat:failed", {
          error: serializeError(error),
        });
      }
    },
  );
}

export function startTreehouseHeartbeat(
  scriptPath: string,
  repoRoot: string,
  token: string,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    treehouseHeartbeat(scriptPath, repoRoot, token);
  }, TREEHOUSE_HEARTBEAT_INTERVAL_MS);
  // Don't let the heartbeat keep the process alive on its own.
  timer.unref();
  return timer;
}

// Return the lease: quits the clone's Editor and resets the clone to base. MUST
// be called only AFTER the run's commits have been flowed back to the main repo
// — the reset discards the clone's branch state. Synchronous and swallows
// errors so it is safe to call from a process "exit" handler.
export function treehouseReturn(
  scriptPath: string,
  repoRoot: string,
  token: string,
): void {
  try {
    execFileSync("bash", [scriptPath, "return", token], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  } catch (error) {
    appendDebugLog("treehouse:return:failed", { error: serializeError(error) });
  }
}
