import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("./debug-log.js", () => ({
  appendDebugLog: vi.fn(),
  serializeError: (error: unknown) => ({ message: String(error) }),
}));

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  resolveTreehouseScript,
  treehouseGet,
  treehouseHeartbeat,
  treehouseReturn,
} from "./treehouse.js";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);
const mockExistsSync = vi.mocked(existsSync);

function argsOf(call: unknown[] | undefined): string[] {
  if (!call) throw new Error("expected a call");
  return call[1] as string[];
}

describe("resolveTreehouseScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GNHF_TREEHOUSE_SCRIPT;
  });

  it("defaults to <repoRoot>/scripts/treehouse.sh when present", () => {
    mockExistsSync.mockReturnValue(true);
    expect(resolveTreehouseScript("/repo")).toBe("/repo/scripts/treehouse.sh");
  });

  it("honors a GNHF_TREEHOUSE_SCRIPT override", () => {
    mockExistsSync.mockReturnValue(true);
    process.env.GNHF_TREEHOUSE_SCRIPT = "/custom/th.sh";
    expect(resolveTreehouseScript("/repo")).toBe("/custom/th.sh");
  });

  it("throws a helpful error when no script is found", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => resolveTreehouseScript("/repo")).toThrow(
      /pool-control script/,
    );
  });
});

describe("treehouseGet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses the lease JSON line and forwards --wait", () => {
    mockExecFileSync.mockReturnValue(
      'treehouse: launching editor\n' +
        '{"leased":true,"slot":2,"path":"/clone","port":8083,"token":"tok","ref":"main"}\n' as unknown as Buffer,
    );

    const lease = treehouseGet("/repo/scripts/treehouse.sh", "/repo", {
      branch: "main",
      label: "gnhf:x",
      wait: true,
    });

    expect(lease).toEqual({
      slot: 2,
      path: "/clone",
      port: 8083,
      token: "tok",
      ref: "main",
    });
    expect(argsOf(mockExecFileSync.mock.calls[0])).toEqual([
      "/repo/scripts/treehouse.sh",
      "get",
      "--branch",
      "main",
      "--label",
      "gnhf:x",
      "--wait",
    ]);
  });

  it("omits --wait when not requested", () => {
    mockExecFileSync.mockReturnValue(
      '{"leased":true,"slot":1,"path":"/c","port":8082,"token":"t"}' as unknown as Buffer,
    );
    treehouseGet("/s", "/repo", { branch: "dev", label: "l", wait: false });
    expect(argsOf(mockExecFileSync.mock.calls[0])).not.toContain("--wait");
  });

  it("throws (surfacing the reason) when the pool did not lease", () => {
    mockExecFileSync.mockReturnValue(
      '{"leased":false,"reason":"max-wait exceeded"}' as unknown as Buffer,
    );
    expect(() =>
      treehouseGet("/s", "/repo", { branch: "main", label: "l", wait: false }),
    ).toThrow(/max-wait exceeded/);
  });

  it("throws a provisioning hint when the script exits non-zero", () => {
    mockExecFileSync.mockImplementation(() => {
      const error = new Error("Command failed") as Error & { status?: number };
      error.status = 3;
      throw error;
    });
    expect(() =>
      treehouseGet("/s", "/repo", { branch: "main", label: "l", wait: false }),
    ).toThrow(/exit 3/);
  });
});

describe("treehouseReturn / treehouseHeartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("return shells out to `return <token>` and swallows failures", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => treehouseReturn("/s", "/repo", "tok")).not.toThrow();
    expect(argsOf(mockExecFileSync.mock.calls[0])).toEqual([
      "/s",
      "return",
      "tok",
    ]);
  });

  it("heartbeat invokes execFile with `heartbeat <token>`", () => {
    treehouseHeartbeat("/s", "/repo", "tok");
    expect(argsOf(mockExecFile.mock.calls[0])).toEqual([
      "/s",
      "heartbeat",
      "tok",
    ]);
  });
});
