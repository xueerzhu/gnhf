import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { Command, InvalidArgumentError } from "commander";
import {
  AGENT_NAMES,
  isAgentSpec,
  loadConfig,
  redactAgentSpecForLogs,
  type AgentName,
  type AgentSpec,
} from "./core/config.js";
import {
  appendDebugLog,
  initDebugLog,
  serializeError,
} from "./core/debug-log.js";
import {
  ensureCleanWorkingTree,
  createBranch,
  getHeadCommit,
  getCurrentBranch,
  getRepoRootDir,
  createWorktree,
  removeWorktree,
  listWorktreePaths,
  getBranchCommitCount,
  getBranchDiffStats,
  fetchBranchFromPath,
  type BranchDiffStats,
} from "./core/git.js";
import {
  resolveTreehouseScript,
  treehouseGet,
  startTreehouseHeartbeat,
  treehouseReturn,
  type TreehouseLease,
} from "./core/treehouse.js";
import {
  type RunInfo,
  type RunSchemaOptions,
  setupRun,
  resumeRun,
  peekRunMetadata,
  getLastIterationNumber,
} from "./core/run.js";
import { readStdinText } from "./core/stdin.js";
import { startSleepPrevention } from "./core/sleep.js";
import { createAgent } from "./core/agents/factory.js";
import { getDefaultTelemetry, initDefaultTelemetry } from "./core/telemetry.js";
import {
  getCommitMessageSchemaFields,
  type CommitMessageConfig,
} from "./core/commit-message.js";
import { Orchestrator } from "./core/orchestrator.js";
import { renderExitSummary } from "./core/exit-summary.js";
import { MockOrchestrator } from "./mock-orchestrator.js";
import { Renderer } from "./renderer.js";
import { slugifyPrompt } from "./utils/slugify.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;
const FORCE_EXIT_TIMEOUT_MS = 5_000;
const MAX_METEOR_FREQUENCY = 5;
const GNHF_REEXEC_STDIN_PROMPT = "GNHF_REEXEC_STDIN_PROMPT";
const GNHF_REEXEC_STDIN_PROMPT_FILE = "GNHF_REEXEC_STDIN_PROMPT_FILE";
const GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX = "gnhf-stdin-";
const GNHF_REEXEC_STDIN_PROMPT_FILENAME = "prompt.txt";
const AGENT_NAME_SET = new Set<string>(AGENT_NAMES);
const AGENT_NAME_LIST = `"${AGENT_NAMES.slice(0, -1).join('", "')}", or "${
  AGENT_NAMES[AGENT_NAMES.length - 1]
}"`;
const AGENT_SPEC_LIST = `${AGENT_NAME_LIST}, or "acp:<target-or-command>" (e.g. acp:gemini)`;

class PromptSignalError extends Error {
  constructor(public readonly signal: NodeJS.Signals) {
    super(signal);
  }
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("must be a safe integer");
  }

  return parsed;
}

function parseMeteorFrequency(value: string): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed > MAX_METEOR_FREQUENCY) {
    throw new InvalidArgumentError(
      `must be between 0 and ${MAX_METEOR_FREQUENCY}`,
    );
  }
  return parsed;
}

function parseOnOffBoolean(value: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new InvalidArgumentError(
    'must be one of: "on", "off", "true", "false"',
  );
}

function humanizeErrorMessage(message: string): string {
  if (message.includes("not a git repository")) {
    return 'This command must be run inside a Git repository. Change into a repo or run "git init" first.';
  }

  return message;
}

function isAgentName(name: string): name is AgentName {
  return AGENT_NAME_SET.has(name);
}

function getNativeAgentName(spec: AgentSpec): AgentName | undefined {
  return isAgentName(spec) ? spec : undefined;
}

function getTelemetryAgent(spec: AgentSpec): string {
  return redactAgentSpecForLogs(spec);
}

function shouldUseColor(): boolean {
  return (
    process.stdout.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== "dumb"
  );
}

function emptyBranchDiffStats(commitCount: number): BranchDiffStats {
  return {
    commits: commitCount,
    filesChanged: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesDeleted: 0,
    filesRenamed: 0,
    binaryFiles: 0,
    linesAdded: 0,
    linesDeleted: 0,
  };
}

function redactDebugArgs(args: string[]): string[] {
  const redacted = [...args];
  for (let i = 0; i < redacted.length; i += 1) {
    const arg = redacted[i];
    if (arg === "--") break;
    if (arg === "--agent") {
      const next = redacted[i + 1];
      if (next !== undefined) {
        redacted[i + 1] = redactAgentSpecForLogs(next);
        i += 1;
      }
      continue;
    }
    if (arg?.startsWith("--agent=")) {
      redacted[i] =
        `--agent=${redactAgentSpecForLogs(arg.slice("--agent=".length))}`;
    }
  }
  return redacted;
}

function buildSchemaOptions(
  stopWhen: string | undefined,
  commitMessage: CommitMessageConfig | undefined,
): RunSchemaOptions {
  const commitFields = getCommitMessageSchemaFields(commitMessage);
  return {
    includeStopField: stopWhen !== undefined,
    ...(stopWhen === undefined ? {} : { stopWhen }),
    ...(commitMessage === undefined ? {} : { commitMessage }),
    ...(commitFields.length === 0 ? {} : { commitFields }),
  };
}

function buildResumeSchemaOptions(
  stopWhen: string | undefined,
  commitMessage: CommitMessageConfig | undefined,
): RunSchemaOptions {
  const commitFields = getCommitMessageSchemaFields(commitMessage);
  if (stopWhen === "") {
    return {
      includeStopField: false,
      clearStopWhen: true,
      ...(commitMessage === undefined ? {} : { commitMessage }),
      ...(commitFields.length === 0 ? {} : { commitFields }),
    };
  }
  return buildSchemaOptions(stopWhen, commitMessage);
}

function initializeNewBranch(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureCleanWorkingTree(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = createBranchWithSuffix(slugifyPrompt(prompt), cwd);
  const runId = branchName.split("/")[1]!;
  return setupRun(runId, prompt, baseCommit, cwd, schemaOptions);
}

function promptRunId(prompt: string): string {
  return slugifyPrompt(prompt).split("/")[1]!;
}

function resumeCurrentBranchRun(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo | null {
  const runId = promptRunId(prompt);
  if (!existsSync(join(cwd, ".gnhf", "runs", runId))) {
    return null;
  }
  ensureCleanWorkingTree(cwd);
  return resumeRun(runId, cwd, schemaOptions);
}

function initializeCurrentBranchRun(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
): RunInfo {
  ensureCleanWorkingTree(cwd);
  const baseCommit = getHeadCommit(cwd);
  const runId = createRunIdWithSuffix(promptRunId(prompt), cwd);
  return setupRun(runId, prompt, baseCommit, cwd, schemaOptions);
}

function branchNameWithSuffix(branchName: string, suffix: number): string {
  return suffix === 0 ? branchName : `${branchName}-${suffix}`;
}

function isCollisionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|exists already|would be overwritten/i.test(message);
}

function createBranchWithSuffix(branchName: string, cwd: string): string {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = branchNameWithSuffix(branchName, suffix);
    try {
      createBranch(candidate, cwd);
      return candidate;
    } catch (error) {
      if (!isCollisionError(error)) throw error;
    }
  }
  throw new Error(`Unable to create a unique branch name for ${branchName}`);
}

function runIdWithSuffix(runId: string, suffix: number): string {
  return suffix === 0 ? runId : `${runId}-${suffix}`;
}

function createRunIdWithSuffix(runId: string, cwd: string): string {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = runIdWithSuffix(runId, suffix);
    if (!existsSync(join(cwd, ".gnhf", "runs", candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to create a unique run id for ${runId}`);
}

interface WorktreeRunResult {
  runInfo: RunInfo;
  worktreePath: string;
  effectiveCwd: string;
  resumed: boolean;
}

function initializeWorktreeRun(
  prompt: string,
  cwd: string,
  schemaOptions: RunSchemaOptions,
  resumeSchemaOptions: RunSchemaOptions,
): WorktreeRunResult {
  // Intentionally skip ensureCleanWorkingTree() — git worktree add creates
  // an independent working directory from HEAD; uncommitted changes in the
  // main checkout don't carry over, so a dirty tree is harmless here.
  const repoRoot = getRepoRootDir(cwd);
  const baseCommit = getHeadCommit(cwd);
  const branchName = slugifyPrompt(prompt);
  const makeWorktreePath = (runId: string) =>
    join(dirname(repoRoot), `${basename(repoRoot)}-gnhf-worktrees`, runId);
  const runId = branchName.split("/")[1]!;
  const worktreePath = makeWorktreePath(runId);
  const registeredWorktreePaths = listWorktreePaths(repoRoot);

  const resumePreservedWorktree = (
    candidateBranchName: string,
    candidateRunId: string,
    candidateWorktreePath: string,
  ): WorktreeRunResult | null => {
    if (
      !registeredWorktreePaths.has(resolve(candidateWorktreePath)) ||
      !existsSync(join(candidateWorktreePath, ".gnhf", "runs", candidateRunId))
    ) {
      return null;
    }

    let worktreeBranch: string;
    try {
      worktreeBranch = getCurrentBranch(candidateWorktreePath);
    } catch (error) {
      throw new Error(
        `Preserved worktree at ${candidateWorktreePath} is in an unexpected state ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Fix the worktree manually or remove it with ` +
          `"git worktree remove ${candidateWorktreePath}" before re-running.`,
      );
    }
    if (worktreeBranch !== candidateBranchName) {
      throw new Error(
        `Preserved worktree at ${candidateWorktreePath} is on branch ` +
          `"${worktreeBranch}" rather than "${candidateBranchName}". ` +
          `Restore it to "${candidateBranchName}" with "git -C ${candidateWorktreePath} ` +
          `checkout ${candidateBranchName}", or remove the worktree with ` +
          `"git worktree remove ${candidateWorktreePath}" to start fresh.`,
      );
    }
    const runInfo = resumeRun(
      candidateRunId,
      candidateWorktreePath,
      resumeSchemaOptions,
    );
    return {
      runInfo,
      worktreePath: candidateWorktreePath,
      effectiveCwd: candidateWorktreePath,
      resumed: true,
    };
  };

  let createdBranchName = branchName;
  let createdRunId = runId;
  let createdWorktreePath = worktreePath;
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidateBranchName = branchNameWithSuffix(branchName, suffix);
    const candidateRunId = candidateBranchName.split("/")[1]!;
    const candidateWorktreePath = makeWorktreePath(candidateRunId);
    const resumed = resumePreservedWorktree(
      candidateBranchName,
      candidateRunId,
      candidateWorktreePath,
    );
    if (resumed) return resumed;
  }
  for (let suffix = 0; suffix < 100; suffix += 1) {
    createdBranchName = branchNameWithSuffix(branchName, suffix);
    createdRunId = createdBranchName.split("/")[1]!;
    createdWorktreePath = makeWorktreePath(createdRunId);
    const resumed = resumePreservedWorktree(
      createdBranchName,
      createdRunId,
      createdWorktreePath,
    );
    if (resumed) return resumed;
    try {
      createWorktree(repoRoot, createdWorktreePath, createdBranchName);
      break;
    } catch (error) {
      if (!isCollisionError(error)) throw error;
      if (suffix === 99) {
        throw new Error(`Unable to create a unique worktree for ${branchName}`);
      }
    }
  }
  const runInfo = setupRun(
    createdRunId,
    prompt,
    baseCommit,
    createdWorktreePath,
    schemaOptions,
  );
  return {
    runInfo,
    worktreePath: createdWorktreePath,
    effectiveCwd: createdWorktreePath,
    resumed: false,
  };
}

function openPromptTerminal(): {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  cleanup: () => void;
} {
  if (process.stdin.isTTY) {
    return {
      input: process.stdin,
      output: process.stderr,
      cleanup: () => {},
    };
  }

  const inputPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  const outputPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";
  const inputFd = openSync(inputPath, "r");
  try {
    const outputFd = openSync(outputPath, "w");
    try {
      const input = createReadStream("", { autoClose: true, fd: inputFd });
      const output = createWriteStream("", { autoClose: true, fd: outputFd });
      return {
        input,
        output,
        cleanup: () => {
          input.destroy();
          output.destroy();
        },
      };
    } catch (error) {
      closeSync(outputFd);
      throw error;
    }
  } catch (error) {
    closeSync(inputFd);
    throw error;
  }
}

function ask(
  question: string,
  closeMessage: string,
  unavailableMessage: string,
): Promise<string> {
  let terminal;
  try {
    terminal = openPromptTerminal();
  } catch {
    throw new Error(unavailableMessage);
  }

  const rl = createInterface({
    input: terminal.input,
    output: terminal.output,
  });
  return new Promise((resolve, reject) => {
    const handleClose = () => {
      terminal.cleanup();
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      reject(new Error(closeMessage));
    };

    const handleSigInt = () => {
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      rl.close();
      terminal.cleanup();
      reject(new PromptSignalError("SIGINT"));
    };

    rl.once("close", handleClose);
    rl.once("SIGINT", handleSigInt);
    rl.question(question, (answer) => {
      rl.off("close", handleClose);
      rl.off("SIGINT", handleSigInt);
      rl.close();
      terminal.cleanup();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function getSignalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

function persistStdinPromptForReexec(prompt: string): {
  path: string;
  cleanup: () => void;
} {
  const promptDir = mkdtempSync(
    join(tmpdir(), GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX),
  );
  const promptPath = join(promptDir, GNHF_REEXEC_STDIN_PROMPT_FILENAME);
  writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
  return {
    path: promptPath,
    cleanup: () => {
      rmSync(promptDir, { recursive: true, force: true });
    },
  };
}

function isTrustedReexecPromptPath(promptPath: string): boolean {
  const resolvedPromptPath = resolve(promptPath);
  const promptDir = dirname(resolvedPromptPath);
  return (
    basename(resolvedPromptPath) === GNHF_REEXEC_STDIN_PROMPT_FILENAME &&
    dirname(promptDir) === resolve(tmpdir()) &&
    basename(promptDir).startsWith(GNHF_REEXEC_STDIN_PROMPT_DIR_PREFIX)
  );
}

function cleanupTrustedReexecPromptPath(promptPath: string): void {
  if (!isTrustedReexecPromptPath(promptPath)) {
    return;
  }

  const resolvedPromptPath = resolve(promptPath);
  rmSync(resolvedPromptPath, { force: true });
  try {
    rmdirSync(dirname(resolvedPromptPath));
  } catch {
    // Leave the directory in place if anything unexpected remains.
  }
}

function readReexecStdinPrompt(env: NodeJS.ProcessEnv): string | undefined {
  const promptPath = env[GNHF_REEXEC_STDIN_PROMPT_FILE];
  if (promptPath !== undefined) {
    delete env[GNHF_REEXEC_STDIN_PROMPT_FILE];
    try {
      return readFileSync(promptPath, "utf-8");
    } finally {
      cleanupTrustedReexecPromptPath(promptPath);
    }
  }

  const prompt = env[GNHF_REEXEC_STDIN_PROMPT];
  if (prompt !== undefined) {
    delete env[GNHF_REEXEC_STDIN_PROMPT];
    return prompt;
  }

  return undefined;
}

const program = new Command();

program
  .name("gnhf")
  .description("Before I go to bed, I tell my agents: good night, have fun")
  .version(packageVersion)
  .argument("[prompt]", "The objective for the coding agent")
  .option(
    "--agent <agent>",
    `Agent to use (${AGENT_NAMES.join(", ")}, or acp:<target-or-command>)`,
  )
  .option(
    "--max-iterations <n>",
    "Abort after N total iterations",
    parseNonNegativeInteger,
  )
  .option(
    "--max-tokens <n>",
    "Abort after N total input+output tokens",
    parseNonNegativeInteger,
  )
  .option(
    "--stop-when <condition>",
    'End when the agent reports this condition, after any commit-failure repair; resumes reuse it, pass a new value to overwrite or "" to clear',
  )
  .option(
    "--prevent-sleep <mode>",
    'Prevent system sleep during the run ("on" or "off")',
    parseOnOffBoolean,
  )
  .option(
    "--worktree",
    "Run in a separate git worktree (enables multiple agents on the same repo)",
    false,
  )
  .option(
    "--current-branch",
    "Run on the current branch instead of creating a gnhf branch",
    false,
  )
  .option(
    "--treehouse",
    "Run in a leased treehouse pool clone (a real isolated checkout on its own Unity QA port) instead of a git worktree; lands the gnhf branch back in the main repo on exit. Requires a pool-control script (see GNHF_TREEHOUSE_SCRIPT)",
    false,
  )
  .option(
    "--push",
    "Push the current branch after each successful iteration",
    false,
  )
  .option(
    "--meteor-frequency <n>",
    "Meteor frequency from 0 to 5 (0 disables, 3 is default)",
    parseMeteorFrequency,
    3,
  )
  .option("--mock", "", false)
  .action(
    async (
      promptArg: string | undefined,
      options: {
        agent?: string;
        maxIterations?: number;
        maxTokens?: number;
        stopWhen?: string;
        preventSleep?: boolean;
        worktree: boolean;
        currentBranch: boolean;
        treehouse: boolean;
        push: boolean;
        meteorFrequency: number;
        mock: boolean;
      },
    ) => {
      if (options.mock) {
        const mock = new MockOrchestrator();
        enterAltScreen();
        const renderer = new Renderer(
          mock as unknown as Orchestrator,
          "let's minimize app startup latency without sacrificing any functionality",
          "codex",
          () => {
            mock.handleInterrupt();
          },
          { meteorFrequency: options.meteorFrequency },
        );
        renderer.start();
        mock.start();
        await renderer.waitUntilExit();
        exitAltScreen();
        return;
      }
      let initialSleepPrevention: Awaited<
        ReturnType<typeof startSleepPrevention>
      > | null = null;
      if (process.env.GNHF_SLEEP_INHIBITED === "1") {
        initialSleepPrevention = await startSleepPrevention(
          process.argv.slice(2),
        );
      }
      let prompt = promptArg;
      let promptFromStdin = false;

      const agentName = options.agent;
      if (agentName !== undefined && !isAgentSpec(agentName)) {
        console.error(
          `Unknown agent: ${options.agent}. Use ${AGENT_SPEC_LIST}.`,
        );
        process.exit(1);
      }

      const loadedConfig = loadConfig(
        agentName
          ? {
              agent: agentName,
            }
          : {},
      );
      const config = {
        ...loadedConfig,
        ...(options.preventSleep === undefined
          ? {}
          : { preventSleep: options.preventSleep }),
      };
      if (!isAgentSpec(config.agent)) {
        console.error(
          `Unknown agent: ${config.agent}. Use ${AGENT_SPEC_LIST}.`,
        );
        process.exit(1);
      }

      initDefaultTelemetry({
        app: "gnhf",
        version: packageVersion,
        platform: process.platform,
        arch: process.arch,
      });
      const telemetry = getDefaultTelemetry();
      const runStartedAt = Date.now();

      if (!prompt && process.env.GNHF_SLEEP_INHIBITED === "1") {
        prompt = readReexecStdinPrompt(process.env);
      }
      if (!prompt && !process.stdin.isTTY) {
        prompt = await readStdinText(process.stdin);
        promptFromStdin = true;
      }

      const cwd = process.cwd();
      let effectiveCwd = cwd;
      let worktreePath: string | null = null;
      let worktreeCleanup: (() => void) | null = null;
      let treehouseLease: TreehouseLease | null = null;
      let treehouseScript: string | null = null;
      let treehouseRepoRoot: string | null = null;
      let treehouseHeartbeatTimer: NodeJS.Timeout | null = null;
      let treehouseReturned = false;
      let treehouseFinalizeRan = false;

      const currentBranch = getCurrentBranch(cwd);
      const onGnhfBranch = currentBranch.startsWith("gnhf/");

      const exclusiveModeCount = [
        options.worktree,
        options.currentBranch,
        options.treehouse,
      ].filter(Boolean).length;
      if (exclusiveModeCount > 1) {
        console.error(
          "Choose at most one of --worktree, --current-branch, and --treehouse.",
        );
        process.exit(1);
      }

      const cliStopWhen =
        options.stopWhen === "" ? undefined : options.stopWhen;
      let effectiveStopWhen = cliStopWhen;
      let effectiveCommitMessage = config.commitMessage;
      let schemaOptions = buildSchemaOptions(
        effectiveStopWhen,
        effectiveCommitMessage,
      );

      let runInfo;
      let startIteration = 0;

      if (options.treehouse) {
        if (!prompt) {
          program.help();
          return;
        }

        if (onGnhfBranch) {
          console.error(
            "Cannot use --treehouse from a gnhf branch. Switch to the base branch first.",
          );
          process.exit(1);
        }

        treehouseRepoRoot = getRepoRootDir(cwd);
        treehouseScript = resolveTreehouseScript(treehouseRepoRoot);
        console.error(
          `\n  gnhf: leasing a treehouse clone on "${currentBranch}" ` +
            `(a cold Unity Editor start can take 1-2 min)...\n`,
        );
        const lease = treehouseGet(treehouseScript, treehouseRepoRoot, {
          branch: currentBranch,
          label: `gnhf:${promptRunId(prompt)}`,
          wait: true,
        });
        treehouseLease = lease;
        effectiveCwd = lease.path;

        // The leased clone is synced to the base branch; carve the gnhf branch
        // inside it. Collision-safe because a prior lease on this slot may have
        // left the ref behind (return resets the working tree, not refs).
        const createdBranch = createBranchWithSuffix(
          slugifyPrompt(prompt),
          effectiveCwd,
        );
        const createdRunId = createdBranch.split("/")[1]!;
        const baseCommit = getHeadCommit(effectiveCwd);
        runInfo = setupRun(
          createdRunId,
          prompt,
          baseCommit,
          effectiveCwd,
          schemaOptions,
        );

        treehouseHeartbeatTimer = startTreehouseHeartbeat(
          treehouseScript,
          treehouseRepoRoot,
          lease.token,
        );

        console.error(
          `\n  gnhf: leased slot ${lease.slot} at ${lease.path} ` +
            `(Unity QA on :${lease.port})\n`,
        );
      } else if (options.worktree) {
        if (!prompt) {
          program.help();
          return;
        }

        if (onGnhfBranch) {
          console.error(
            "Cannot use --worktree from a gnhf branch. Switch to the base branch first.",
          );
          process.exit(1);
        }

        const wt = initializeWorktreeRun(
          prompt,
          cwd,
          schemaOptions,
          buildResumeSchemaOptions(options.stopWhen, effectiveCommitMessage),
        );
        runInfo = wt.runInfo;
        effectiveCwd = wt.effectiveCwd;
        worktreePath = wt.worktreePath;

        if (wt.resumed) {
          // Preserved worktree is always kept on exit regardless of this
          // invocation's commit count; previous commits are already there.
          effectiveStopWhen = runInfo.stopWhen;
          effectiveCommitMessage = runInfo.commitMessage;
          schemaOptions = buildSchemaOptions(
            effectiveStopWhen,
            effectiveCommitMessage,
          );
          startIteration = getLastIterationNumber(runInfo);
          console.error(
            `\n  gnhf: resuming preserved worktree at ${worktreePath}` +
              `\n  gnhf: continuing run ${runInfo.runId} from iteration ${startIteration}\n`,
          );
        } else {
          worktreeCleanup = () => {
            try {
              removeWorktree(cwd, wt.worktreePath);
            } catch {
              // Best-effort cleanup
            }
          };

          // Ensure worktree cleanup runs even if die() or process.exit() is
          // called before reaching the normal cleanup block (e.g. orchestrator
          // crash to .catch to die to process.exit(1)).
          const exitCleanup = worktreeCleanup;
          process.on("exit", () => {
            if (worktreeCleanup === exitCleanup) {
              exitCleanup();
            }
          });
        }
      } else if (options.currentBranch) {
        if (!prompt) {
          program.help();
          return;
        }

        const existing = resumeCurrentBranchRun(
          prompt,
          cwd,
          buildResumeSchemaOptions(options.stopWhen, effectiveCommitMessage),
        );

        if (existing) {
          runInfo = existing;
          effectiveStopWhen = existing.stopWhen;
          effectiveCommitMessage = existing.commitMessage;
          schemaOptions = buildSchemaOptions(
            effectiveStopWhen,
            effectiveCommitMessage,
          );
          startIteration = getLastIterationNumber(existing);
        } else {
          runInfo = initializeCurrentBranchRun(prompt, cwd, schemaOptions);
        }
      } else if (onGnhfBranch) {
        const existingRunId = currentBranch.slice("gnhf/".length);
        const existingMetadata = peekRunMetadata(existingRunId, cwd);
        effectiveCommitMessage = existingMetadata.commitMessage;
        const existingPrompt = readFileSync(
          existingMetadata.promptPath,
          "utf-8",
        );

        if (!prompt || prompt === existingPrompt) {
          const existing = resumeRun(
            existingRunId,
            cwd,
            buildResumeSchemaOptions(
              options.stopWhen,
              existingMetadata.commitMessage,
            ),
          );
          const resumeStopWhen = existing.stopWhen;
          const resumeSchemaOptions = buildSchemaOptions(
            resumeStopWhen,
            existing.commitMessage,
          );
          prompt = existingPrompt;
          runInfo = existing;
          effectiveStopWhen = resumeStopWhen;
          effectiveCommitMessage = existing.commitMessage;
          schemaOptions = resumeSchemaOptions;
          startIteration = getLastIterationNumber(existing);
        } else {
          const answer = await ask(
            `You are on gnhf branch "${currentBranch}".\n` +
              `  (o) Update prompt and continue current run\n` +
              `  (n) Start a new branch on top of this one\n` +
              `  (q) Quit\n` +
              `Choose [o/n/q]: `,
            "The overwrite prompt closed before a choice was entered. Re-run gnhf from an interactive terminal and choose o, n, or q.",
            "Cannot show the overwrite prompt because stdin is not interactive. Re-run gnhf from an interactive terminal and choose o, n, or q.",
          );

          if (answer === "o") {
            ensureCleanWorkingTree(cwd);
            const existing = resumeRun(
              existingRunId,
              cwd,
              buildResumeSchemaOptions(
                options.stopWhen,
                existingMetadata.commitMessage,
              ),
            );
            const resumeStopWhen = existing.stopWhen;
            const resumeSchemaOptions = buildSchemaOptions(
              resumeStopWhen,
              existing.commitMessage,
            );
            runInfo = setupRun(
              existingRunId,
              prompt,
              existing.baseCommit,
              cwd,
              resumeSchemaOptions,
            );
            effectiveStopWhen = resumeStopWhen;
            effectiveCommitMessage = existing.commitMessage;
            schemaOptions = resumeSchemaOptions;
            startIteration = getLastIterationNumber(existing);
          } else if (answer === "n") {
            effectiveStopWhen = cliStopWhen;
            effectiveCommitMessage = config.commitMessage;
            schemaOptions = buildSchemaOptions(
              effectiveStopWhen,
              effectiveCommitMessage,
            );
            runInfo = initializeNewBranch(prompt, cwd, schemaOptions);
          } else {
            process.exit(0);
          }
        }
      } else {
        if (!prompt) {
          program.help();
          return;
        }

        runInfo = initializeNewBranch(prompt, cwd, schemaOptions);
      }

      // Land a --treehouse run's commits in the main repo, then release the
      // clone. Order is load-bearing: `treehouse return` resets the clone, which
      // would destroy the gnhf branch, so we fetch it into the main repo FIRST
      // and only return once the work is safely landed. If the fetch fails we
      // hold the lease and tell the user where their commits live, rather than
      // resetting the clone and losing them. Idempotent and synchronous so it
      // can double as a process "exit" safety net on a hard crash.
      const finalizeTreehouse = (): void => {
        treehouseFinalizeRan = true;
        if (treehouseHeartbeatTimer) {
          clearInterval(treehouseHeartbeatTimer);
          treehouseHeartbeatTimer = null;
        }
        if (
          !treehouseLease ||
          !treehouseScript ||
          !treehouseRepoRoot ||
          treehouseReturned
        ) {
          return;
        }

        let branchName = "HEAD";
        let commitCount = 0;
        try {
          branchName = getCurrentBranch(effectiveCwd);
        } catch {
          // Fall back to HEAD; nothing actionable without a branch name.
        }
        try {
          commitCount = getBranchCommitCount(runInfo.baseCommit, effectiveCwd);
        } catch {
          // Treat an unreadable count as "no work"; return path stays safe.
        }

        if (commitCount > 0) {
          try {
            fetchBranchFromPath(
              treehouseRepoRoot,
              treehouseLease.path,
              branchName,
            );
          } catch (error) {
            appendDebugLog("treehouse:flowback-failed", {
              error: serializeError(error),
              branchName,
              clonePath: treehouseLease.path,
            });
            console.error(
              `\n  gnhf: could not land "${branchName}" in the main repo ` +
                `(${error instanceof Error ? error.message : String(error)}).` +
                `\n  gnhf: holding the lease so your work is NOT lost — it is committed in the clone at:` +
                `\n        ${treehouseLease.path}` +
                `\n  gnhf: recover it, then release the slot with: ` +
                `${treehouseScript} return ${treehouseLease.token}\n`,
            );
            return; // do NOT return the lease — returning resets the clone
          }
        }

        treehouseReturned = true;
        treehouseReturn(treehouseScript, treehouseRepoRoot, treehouseLease.token);
        if (commitCount > 0) {
          console.error(
            `\n  gnhf: landed "${branchName}" in the main repo — review and merge it there. ` +
              `Released treehouse slot ${treehouseLease.slot}.\n`,
          );
        } else {
          appendDebugLog("treehouse:returned-empty", {
            slot: treehouseLease.slot,
          });
        }
      };

      if (treehouseLease) {
        process.on("exit", () => {
          if (!treehouseFinalizeRan) {
            finalizeTreehouse();
          }
        });
      }

      let sleepPreventionCleanup: (() => Promise<void>) | null = null;
      if (config.preventSleep) {
        const persistedPrompt =
          promptFromStdin && prompt !== undefined
            ? persistStdinPromptForReexec(prompt)
            : null;
        let reexeced = false;
        try {
          const sleepPrevention =
            initialSleepPrevention ??
            (await startSleepPrevention(process.argv.slice(2), {
              reexecEnv: persistedPrompt
                ? {
                    [GNHF_REEXEC_STDIN_PROMPT_FILE]: persistedPrompt.path,
                  }
                : undefined,
            }));
          if (sleepPrevention.type === "reexeced") {
            reexeced = true;
            process.exit(sleepPrevention.exitCode);
          }
          if (sleepPrevention.type === "active") {
            sleepPreventionCleanup = sleepPrevention.cleanup;
          }
        } finally {
          if (!reexeced) {
            persistedPrompt?.cleanup();
          }
        }
      }

      const runMode:
        | "new"
        | "resume"
        | "worktree"
        | "current-branch"
        | "treehouse" = options.treehouse
        ? "treehouse"
        : options.worktree
          ? "worktree"
          : options.currentBranch
            ? "current-branch"
            : startIteration > 0
              ? "resume"
              : "new";

      const telemetryAgent = getTelemetryAgent(config.agent);
      telemetry.pageview("/run", {
        agent: telemetryAgent,
        mode: runMode,
      });

      initDebugLog(runInfo.logPath);
      appendDebugLog("run:start", {
        args: redactDebugArgs(process.argv.slice(2)),
        runId: runInfo.runId,
        runDir: runInfo.runDir,
        agent: redactAgentSpecForLogs(config.agent),
        promptLength: prompt.length,
        promptFromStdin,
        startIteration,
        maxIterations: options.maxIterations,
        maxTokens: options.maxTokens,
        stopWhen: effectiveStopWhen,
        commitMessage: effectiveCommitMessage,
        preventSleep: config.preventSleep,
        agentArgsOverride: getNativeAgentName(config.agent)
          ? config.agentArgsOverride?.[getNativeAgentName(config.agent)!]
          : undefined,
        worktree: options.worktree,
        worktreePath,
        treehouse: options.treehouse,
        treehouseSlot: treehouseLease?.slot,
        treehousePort: treehouseLease?.port,
        treehouseClonePath: treehouseLease?.path,
        currentBranch: options.currentBranch,
        push: options.push,
        platform: process.platform,
        nodeVersion: process.version,
        gnhfVersion: packageVersion,
      });

      const nativeAgent = getNativeAgentName(config.agent);
      const agent = createAgent(
        config.agent,
        runInfo,
        nativeAgent ? config.agentPathOverride[nativeAgent] : undefined,
        nativeAgent ? config.agentArgsOverride?.[nativeAgent] : undefined,
        {
          ...schemaOptions,
          acpRegistryOverrides: config.acpRegistryOverrides,
        },
      );
      const orchestrator = new Orchestrator(
        { ...config, commitMessage: effectiveCommitMessage },
        agent,
        runInfo,
        prompt,
        effectiveCwd,
        startIteration,
        {
          maxIterations: options.maxIterations,
          maxTokens: options.maxTokens,
          stopWhen: effectiveStopWhen,
          ...(options.push ? { push: true } : {}),
        },
      );
      let shutdownSignal: NodeJS.Signals | null = null;
      let forceShutdownRequested = false;

      const requestForceShutdown = (signal: NodeJS.Signals) => {
        if (forceShutdownRequested) return;
        forceShutdownRequested = true;
        shutdownSignal = signal;
        appendDebugLog(`signal:${signal}`);
        renderer.stop();
      };
      const handleSigInt = () => {
        const disposition = orchestrator.handleInterrupt();
        if (disposition === "force-stop") {
          requestForceShutdown("SIGINT");
          return;
        }
        if (disposition === "exit") {
          shutdownSignal = "SIGINT";
          appendDebugLog("signal:SIGINT");
          renderer.stop("interrupted");
          return;
        }
        shutdownSignal = "SIGINT";
        appendDebugLog("signal:SIGINT");
      };
      const handleSigTerm = () => {
        orchestrator.stop();
        requestForceShutdown("SIGTERM");
      };

      enterAltScreen();
      const renderer = new Renderer(
        orchestrator,
        prompt,
        config.agent,
        handleSigInt,
        { meteorFrequency: options.meteorFrequency },
      );
      renderer.start();

      process.on("SIGINT", handleSigInt);
      process.on("SIGTERM", handleSigTerm);

      const orchestratorPromise = orchestrator
        .start()
        .finally(() => {
          // Only aborted runs keep the done screen open. Graceful stops should
          // exit as soon as the current iteration and shutdown cleanup finish,
          // but a real abort still deserves the done screen even if a prior
          // ctrl+c already set the eventual SIGINT exit code.
          const keepTui =
            orchestrator.getState().status === "aborted" && process.stdin.isTTY;
          if (!keepTui) {
            renderer.stop();
          }
        })
        .catch((err) => {
          appendDebugLog("orchestrator:fatal", {
            error: serializeError(err),
          });
          exitAltScreen();
          die(err instanceof Error ? err.message : String(err));
        });

      try {
        const rendererExitReason = await renderer.waitUntilExit();
        if (rendererExitReason === "interrupted" && !shutdownSignal) {
          shutdownSignal = "SIGINT";
          appendDebugLog("signal:SIGINT");
        }
        exitAltScreen();
        const shutdownResult = await Promise.race([
          orchestratorPromise.then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), FORCE_EXIT_TIMEOUT_MS).unref();
          }),
        ]);

        if (shutdownResult === "timeout") {
          appendDebugLog("run:shutdown-timeout", {
            timeoutMs: FORCE_EXIT_TIMEOUT_MS,
          });
          console.error(
            `\n  gnhf: shutdown timed out after ${FORCE_EXIT_TIMEOUT_MS / 1000}s, forcing exit\n`,
          );
          process.exit(getSignalExitCode(shutdownSignal ?? "SIGINT"));
        }
      } finally {
        process.off("SIGINT", handleSigInt);
        process.off("SIGTERM", handleSigTerm);
        await sleepPreventionCleanup?.();
      }

      {
        const finalState = orchestrator.getState();
        let finalBranchName = "HEAD";
        try {
          finalBranchName = getCurrentBranch(effectiveCwd);
        } catch (error) {
          appendDebugLog("summary:branch-error", {
            error: serializeError(error),
          });
        }

        let diffStats = emptyBranchDiffStats(finalState.commitCount);
        try {
          diffStats = getBranchDiffStats(runInfo.baseCommit, effectiveCwd);
        } catch (error) {
          appendDebugLog("summary:diff-stats-error", {
            error: serializeError(error),
          });
        }

        const exitSummary = renderExitSummary({
          agentName: redactAgentSpecForLogs(config.agent),
          branchName: finalBranchName,
          elapsedMs: Date.now() - finalState.startTime.getTime(),
          status: finalState.status,
          abortReason: finalState.lastAgentError ?? finalState.lastMessage,
          iterations: finalState.currentIteration,
          successCount: finalState.successCount,
          failCount: finalState.failCount,
          totalInputTokens: finalState.totalInputTokens,
          totalOutputTokens: finalState.totalOutputTokens,
          tokensEstimated: finalState.tokensEstimated,
          commitCount: finalState.commitCount,
          notesPath: runInfo.notesPath,
          logPath: runInfo.logPath,
          baseRef: runInfo.baseCommit.slice(0, 12) || runInfo.baseCommit,
          diffStats,
          color: shouldUseColor(),
          terminalColumns: process.stdout.columns,
          hasPendingCommitFailure: finalState.hasPendingCommitFailure,
        });

        appendDebugLog("run:complete", {
          signal: shutdownSignal,
          status: finalState.status,
          iterations: finalState.currentIteration,
          successCount: finalState.successCount,
          failCount: finalState.failCount,
          totalInputTokens: finalState.totalInputTokens,
          totalOutputTokens: finalState.totalOutputTokens,
          commitCount: finalState.commitCount,
          worktreePath,
        });

        telemetry.track("run", {
          agent: telemetryAgent,
          mode: runMode,
          status: finalState.status,
          signal: shutdownSignal ?? undefined,
          iterations: finalState.currentIteration,
          success_count: finalState.successCount,
          fail_count: finalState.failCount,
          commit_count: finalState.commitCount,
          total_input_tokens: finalState.totalInputTokens,
          total_output_tokens: finalState.totalOutputTokens,
          duration_ms: Date.now() - runStartedAt,
          prevent_sleep: config.preventSleep === true,
          push_each_iteration: options.push === true,
          commit_message_preset: effectiveCommitMessage?.preset ?? "default",
          stop_when_set: effectiveStopWhen !== undefined,
        });
        await telemetry.close(1_000);

        if (finalState.status === "aborted") {
          console.error(`\n  gnhf: Run log: ${runInfo.logPath}\n`);
        }

        if (worktreePath) {
          if (
            finalState.commitCount > 0 ||
            finalState.hasPendingCommitFailure
          ) {
            worktreeCleanup = null;
            console.error(
              `\n  gnhf: worktree preserved at ${worktreePath}` +
                `\n  gnhf: merge the branch and remove with: git worktree remove "${worktreePath}"\n`,
            );
          } else {
            worktreeCleanup?.();
            worktreeCleanup = null;
            appendDebugLog("worktree:cleaned-up", {
              worktreePath,
            });
          }
        }

        if (treehouseLease) {
          finalizeTreehouse();
        }

        process.stdout.write(exitSummary);
      }

      if (shutdownSignal) {
        process.exit(getSignalExitCode(shutdownSignal));
      }
    },
  );

function enterAltScreen() {
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");
}

function exitAltScreen() {
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
}

function die(message: string): never {
  console.error(`\n  gnhf: ${humanizeErrorMessage(message)}\n`);
  process.exit(1);
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof PromptSignalError) {
    process.exit(getSignalExitCode(err.signal));
  }
  die(err instanceof Error ? err.message : String(err));
}
