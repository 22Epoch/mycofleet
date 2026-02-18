/**
 * CLI command: mycofleet coordinator start|stop|status
 *
 * Manages the persistent coordinator agent lifecycle. The coordinator runs
 * at the project root (NOT in a worktree), receives work via mail and beads,
 * and dispatches agents via mycofleet sling.
 *
 * Unlike regular agents spawned by sling, the coordinator:
 * - Has no worktree (operates on the main working tree)
 * - Has no bead assignment (it creates beads, not works on them)
 * - Has no overlay CLAUDE.md (context comes via mail + beads + checkpoints)
 * - Persists across work batches
 */

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import { isProcessRunning } from "../watchdog/health.ts";
import { createSession, isSessionAlive, killSession, sendKeys } from "../worktree/tmux.ts";

/** Rebrand state directory. */
const MYCOFLEET_DIR = ".mycofleet";

/** Default coordinator agent name. */
const COORDINATOR_NAME = "coordinator";

/**
 * Build the tmux session name for the coordinator.
 * Includes the project name to prevent cross-project collisions (mycofleet-pcef).
 */
function coordinatorTmuxSession(projectName: string): string {
	return `mycofleet-${projectName}-${COORDINATOR_NAME}`;
}

/** Dependency injection for testing. Uses real implementations when omitted. */
export interface CoordinatorDeps {
	_tmux?: {
		createSession: (
			name: string,
			cwd: string,
			command: string,
			env?: Record<string, string>,
		) => Promise<number>;
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
		sendKeys: (name: string, keys: string) => Promise<void>;
	};
	_watchdog?: {
		start: () => Promise<{ pid: number } | null>;
		stop: () => Promise<boolean>;
		isRunning: () => Promise<boolean>;
	};
	_monitor?: {
		start: (args: string[]) => Promise<{ pid: number } | null>;
		stop: () => Promise<boolean>;
		isRunning: () => Promise<boolean>;
	};
}

/**
 * Read the PID from the watchdog PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function readWatchdogPid(projectRoot: string): Promise<number | null> {
	const pidFilePath = join(projectRoot, MYCOFLEET_DIR, "watchdog.pid");
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Remove the watchdog PID file.
 */
async function removeWatchdogPid(projectRoot: string): Promise<void> {
	const pidFilePath = join(projectRoot, MYCOFLEET_DIR, "watchdog.pid");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Default watchdog implementation for production use.
 * Starts/stops the watchdog daemon via `mycofleet watch --background`.
 */
function createDefaultWatchdog(projectRoot: string): NonNullable<CoordinatorDeps["_watchdog"]> {
	return {
		async start(): Promise<{ pid: number } | null> {
			// Check if watchdog is already running
			const existingPid = await readWatchdogPid(projectRoot);
			if (existingPid !== null && isProcessRunning(existingPid)) {
				return null; // Already running
			}

			// Clean up stale PID file
			if (existingPid !== null) {
				await removeWatchdogPid(projectRoot);
			}

			// Start watchdog in background
			const proc = Bun.spawn(["mycofleet", "watch", "--background"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				return null; // Failed to start
			}

			// Read the PID file that was written by the background process
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) {
				return null; // PID file wasn't created
			}

			return { pid };
		},

		async stop(): Promise<boolean> {
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) {
				return false; // No PID file
			}

			// Check if process is running
			if (!isProcessRunning(pid)) {
				// Process is dead, clean up PID file
				await removeWatchdogPid(projectRoot);
				return false;
			}

			// Kill the process
			try {
				process.kill(pid, 15); // SIGTERM
			} catch {
				return false;
			}

			// Remove PID file
			await removeWatchdogPid(projectRoot);
			return true;
		},

		async isRunning(): Promise<boolean> {
			const pid = await readWatchdogPid(projectRoot);
			if (pid === null) {
				return false;
			}
			return isProcessRunning(pid);
		},
	};
}

/**
 * Default monitor implementation for production use.
 * Starts/stops the monitor agent via `mycofleet monitor start/stop`.
 */
function createDefaultMonitor(projectRoot: string): NonNullable<CoordinatorDeps["_monitor"]> {
	return {
		async start(): Promise<{ pid: number } | null> {
			const proc = Bun.spawn(["mycofleet", "monitor", "start", "--no-attach", "--json"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) return null;
			try {
				const stdout = await new Response(proc.stdout).text();
				const result = JSON.parse(stdout.trim()) as { pid?: number };
				return result.pid ? { pid: result.pid } : null;
			} catch {
				return null;
			}
		},
		async stop(): Promise<boolean> {
			const proc = Bun.spawn(["mycofleet", "monitor", "stop", "--json"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		},
		async isRunning(): Promise<boolean> {
			const proc = Bun.spawn(["mycofleet", "monitor", "status", "--json"], {
				cwd: projectRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) return false;
			try {
				const stdout = await new Response(proc.stdout).text();
				const result = JSON.parse(stdout.trim()) as { running?: boolean };
				return result.running === true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * Build the coordinator startup beacon — the first message sent to the coordinator
 * via tmux send-keys after Claude Code initializes.
 */
export function buildCoordinatorBeacon(): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[MYCOFLEET] ${COORDINATOR_NAME} (coordinator) ${timestamp}`,
		"Depth: 0 | Parent: none | Role: persistent orchestrator",
		"HIERARCHY: You ONLY spawn leads (mycofleet sling --capability lead). Leads spawn scouts, builders, reviewers. NEVER spawn non-lead agents directly.",
		"DELEGATION: For any exploration/scouting, spawn a lead who will spawn scouts. Do NOT explore the codebase yourself beyond initial planning.",
		`Startup: run mulch prime, check mail (mycofleet mail check --agent ${COORDINATOR_NAME}), check bd ready, check mycofleet group status, then begin work`,
	];
	return parts.join(" — ");
}

/**
 * Determine whether to auto-attach to the tmux session after starting.
 * Exported for testing.
 */
export function resolveAttach(args: string[], isTTY: boolean): boolean {
	if (args.includes("--attach")) return true;
	if (args.includes("--no-attach")) return false;
	return isTTY;
}

async function startCoordinator(args: string[], deps: CoordinatorDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const shouldAttach = resolveAttach(args, !!process.stdout.isTTY);
	const watchdogFlag = args.includes("--watchdog");
	const monitorFlag = args.includes("--monitor");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);
	const tmuxSession = coordinatorTmuxSession(config.project.name);

	// Check for existing coordinator
	const mycofleetDir = join(projectRoot, MYCOFLEET_DIR);
	const { store } = openSessionStore(mycofleetDir);
	try {
		const existing = store.getByName(COORDINATOR_NAME);

		if (
			existing &&
			existing.capability === "coordinator" &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const alive = await tmux.isSessionAlive(existing.tmuxSession);
			if (alive) {
				throw new AgentError(
					`Coordinator is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
					{ agentName: COORDINATOR_NAME },
				);
			}
			// Session recorded but tmux is dead — mark as completed and continue
			store.updateState(COORDINATOR_NAME, "completed");
		}

		// Deploy hooks to the project root so the coordinator gets event logging,
		// mail check --inject, and activity tracking via the standard hook pipeline.
		// The ENV_GUARD prefix on all hooks (both template and generated guards)
		// ensures they only activate when OVERSTORY_AGENT_NAME is set (i.e. for
		// the coordinator's tmux session), so the user's own Claude Code session
		// at the project root is unaffected.
		await deployHooks(projectRoot, COORDINATOR_NAME, "coordinator");

		// Create coordinator identity if first run
		const identityBaseDir = join(projectRoot, MYCOFLEET_DIR, "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, COORDINATOR_NAME);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: COORDINATOR_NAME,
				capability: "coordinator",
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.mulch.enabled ? config.mulch.domains : [],
				recentTasks: [],
			});
		}

		// Resolve model from config > manifest > fallback
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const model = resolveModel(config, manifest, "coordinator", "opus");

		// Spawn tmux session at project root with Claude Code (interactive mode).
		const agentDefPath = join(projectRoot, MYCOFLEET_DIR, "agent-defs", "coordinator.md");
		const agentDefFile = Bun.file(agentDefPath);
		let claudeCmd = `claude --model ${model} --dangerously-skip-permissions`;
		if (await agentDefFile.exists()) {
			const agentDef = await agentDefFile.text();
			// Single-quote the content for safe shell expansion (only escape single quotes)
			const escaped = agentDef.replace(/'/g, "'\\''");
			claudeCmd += ` --append-system-prompt '${escaped}'`;
		}
		const pid = await tmux.createSession(tmuxSession, projectRoot, claudeCmd, {
			OVERSTORY_AGENT_NAME: COORDINATOR_NAME,
		});

		// Record session BEFORE sending the beacon.
		const session: AgentSession = {
			id: `session-${Date.now()}-${COORDINATOR_NAME}`,
			agentName: COORDINATOR_NAME,
			capability: "coordinator",
			worktreePath: projectRoot,
			branchName: config.project.canonicalBranch,
			beadId: "",
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(session);

		// Send beacon after TUI initialization delay
		await Bun.sleep(3_000);
		const beacon = buildCoordinatorBeacon();
		await tmux.sendKeys(tmuxSession, beacon);

		// Follow-up Enter to ensure submission (same pattern as sling.ts)
		await Bun.sleep(500);
		await tmux.sendKeys(tmuxSession, "");

		// Auto-start watchdog if --watchdog flag is present
		let watchdogPid: number | undefined;
		if (watchdogFlag) {
			const watchdogResult = await watchdog.start();
			if (watchdogResult) {
				watchdogPid = watchdogResult.pid;
				if (!json) process.stdout.write(`  Watchdog: started (PID ${watchdogResult.pid})\n`);
			} else {
				if (!json) process.stderr.write("  Watchdog: failed to start or already running\n");
			}
		}

		// Auto-start monitor if --monitor flag is present
		let monitorPid: number | undefined;
		if (monitorFlag) {
			const monitorResult = await monitor.start([]);
			if (monitorResult) {
				monitorPid = monitorResult.pid;
				if (!json) process.stdout.write(`  Monitor:  started (PID ${monitorResult.pid})\n`);
			} else {
				if (!json) process.stderr.write("  Monitor:  failed to start or already running\n");
			}
		}

		const output = {
			agentName: COORDINATOR_NAME,
			capability: "coordinator",
			tmuxSession,
			projectRoot,
			pid,
			watchdog: watchdogFlag ? watchdogPid !== undefined : false,
			monitor: monitorFlag ? monitorPid !== undefined : false,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(output)}\n`);
		} else {
			process.stdout.write("Coordinator started\n");
			process.stdout.write(`  Tmux:    ${tmuxSession}\n`);
			process.stdout.write(`  Root:    ${projectRoot}\n`);
			process.stdout.write(`  PID:     ${pid}\n`);
		}

		if (shouldAttach) {
			Bun.spawnSync(["tmux", "attach-session", "-t", tmuxSession], {
				stdio: ["inherit", "inherit", "inherit"],
			});
		}
	} finally {
		store.close();
	}
}

async function stopCoordinator(args: string[], deps: CoordinatorDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

	const mycofleetDir = join(projectRoot, MYCOFLEET_DIR);
	const { store } = openSessionStore(mycofleetDir);
	try {
		const session = store.getByName(COORDINATOR_NAME);

		if (
			!session ||
			session.capability !== "coordinator" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			throw new AgentError("No active coordinator session found", {
				agentName: COORDINATOR_NAME,
			});
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (alive) {
			await tmux.killSession(session.tmuxSession);
		}

		const watchdogStopped = await watchdog.stop();
		const monitorStopped = await monitor.stop();

		store.updateState(COORDINATOR_NAME, "completed");
		store.updateLastActivity(COORDINATOR_NAME);

		// Auto-complete the current run
		let runCompleted = false;
		try {
			const currentRunPath = join(mycofleetDir, "current-run.txt");
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const runId = (await currentRunFile.text()).trim();
				if (runId.length > 0) {
					const runStore = createRunStore(join(mycofleetDir, "sessions.db"));
					try {
						runStore.completeRun(runId, "completed");
						runCompleted = true;
					} finally {
						runStore.close();
					}
					try {
						await unlink(currentRunPath);
					} catch {
						// File may already be gone
					}
				}
			}
		} catch {
			// Non-fatal
		}

		if (json) {
			process.stdout.write(
				`${JSON.stringify({
					stopped: true,
					sessionId: session.id,
					watchdogStopped,
					monitorStopped,
					runCompleted,
				})}\n`,
			);
		} else {
			process.stdout.write(`Coordinator stopped (session: ${session.id})\n`);
			process.stdout.write(watchdogStopped ? "Watchdog stopped\n" : "No watchdog running\n");
			process.stdout.write(monitorStopped ? "Monitor stopped\n" : "No monitor running\n");
			process.stdout.write(runCompleted ? "Run completed\n" : "No active run\n");
		}
	} finally {
		store.close();
	}
}

async function statusCoordinator(args: string[], deps: CoordinatorDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const watchdog = deps._watchdog ?? createDefaultWatchdog(projectRoot);
	const monitor = deps._monitor ?? createDefaultMonitor(projectRoot);

	const mycofleetDir = join(projectRoot, MYCOFLEET_DIR);
	const { store } = openSessionStore(mycofleetDir);
	try {
		const session = store.getByName(COORDINATOR_NAME);
		const watchdogRunning = await watchdog.isRunning();
		const monitorRunning = await monitor.isRunning();

		if (
			!session ||
			session.capability !== "coordinator" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			if (json) {
				process.stdout.write(`${JSON.stringify({ running: false, watchdogRunning, monitorRunning })}\n`);
			} else {
				process.stdout.write("Coordinator is not running\n");
				if (watchdogRunning) process.stdout.write("Watchdog: running\n");
				if (monitorRunning) process.stdout.write("Monitor: running\n");
			}
			return;
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);

		if (!alive) {
			store.updateState(COORDINATOR_NAME, "zombie");
			store.updateLastActivity(COORDINATOR_NAME);
			session.state = "zombie";
		}

		const status = {
			running: alive,
			sessionId: session.id,
			state: session.state,
			tmuxSession: session.tmuxSession,
			pid: session.pid,
			startedAt: session.startedAt,
			lastActivity: session.lastActivity,
			watchdogRunning,
			monitorRunning,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const stateLabel = alive ? "running" : session.state;
			process.stdout.write(`Coordinator: ${stateLabel}\n`);
			process.stdout.write(`  Session:   ${session.id}\n`);
			process.stdout.write(`  Tmux:      ${session.tmuxSession}\n`);
			process.stdout.write(`  PID:       ${session.pid}\n`);
			process.stdout.write(`  Started:   ${session.startedAt}\n`);
			process.stdout.write(`  Activity:  ${session.lastActivity}\n`);
			process.stdout.write(`  Watchdog:  ${watchdogRunning ? "running" : "not running"}\n`);
			process.stdout.write(`  Monitor:   ${monitorRunning ? "running" : "not running"}\n`);
		}
	} finally {
		store.close();
	}
}

const COORDINATOR_HELP = `mycofleet coordinator — Manage the persistent coordinator agent

Usage: mycofleet coordinator <subcommand> [flags]

Subcommands:
  start                    Start the coordinator (spawns Claude Code at project root)
  stop                     Stop the coordinator (kills tmux session)
  status                   Show coordinator state

Start options:
  --attach                 Always attach to tmux session after start
  --no-attach              Never attach to tmux session after start
                           Default: attach when running in an interactive TTY
  --watchdog               Auto-start watchdog daemon with coordinator
  --monitor                Auto-start monitor agent (Tier 2) with coordinator

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The coordinator runs at the project root and orchestrates work by:
  - Decomposing objectives into beads issues
  - Dispatching agents via mycofleet sling
  - Tracking batches via task groups
  - Handling escalations from agents and watchdog`;

export async function coordinatorCommand(
	args: string[],
	deps: CoordinatorDeps = {},
): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${COORDINATOR_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startCoordinator(subArgs, deps);
			break;
		case "stop":
			await stopCoordinator(subArgs, deps);
			break;
		case "status":
			await statusCoordinator(subArgs, deps);
			break;
		default:
			throw new ValidationError(
				`Unknown coordinator subcommand: ${subcommand}. Run 'mycofleet coordinator --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
