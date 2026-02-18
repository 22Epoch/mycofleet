/**
 * CLI command: mycofleet init [--force]
 *
 * Scaffolds the `.overstory/` directory in the current project with:
 * - config.yaml (serialized from DEFAULT_CONFIG)
 * - agent-manifest.json (starter agent definitions)
 * - hooks.json (central hooks config)
 * - Required subdirectories (agents/, worktrees/, specs/, logs/)
 * - .gitignore entries for transient files
 */

import { Database } from "bun:sqlite";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../config.ts";
import { ValidationError } from "../errors.ts";
import type { AgentManifest, MycofleetConfig } from "../types.ts";

const MYCOFLEET_DIR = ".overstory";

/**
 * Detect the project name from git or fall back to directory name.
 */
async function detectProjectName(root: string): Promise<string> {
	// Try git remote origin
	try {
		const proc = Bun.spawn(["git", "remote", "get-url", "origin"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const url = (await new Response(proc.stdout).text()).trim();
			// Extract repo name from URL: git@host:user/repo.git or https://host/user/repo.git
			const match = url.match(/\/([^/]+?)(?:\.git)?$/);
			if (match?.[1]) {
				return match[1];
			}
		}
	} catch {
		// Git not available or not a git repo
	}

	return basename(root);
}

/**
 * Detect the canonical branch name from git.
 */
async function detectCanonicalBranch(root: string): Promise<string> {
	try {
		const proc = Bun.spawn(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const ref = (await new Response(proc.stdout).text()).trim();
			// refs/remotes/origin/main -> main
			const branch = ref.split("/").pop();
			if (branch) {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	// Fall back to checking current branch
	try {
		const proc = Bun.spawn(["git", "branch", "--show-current"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const branch = (await new Response(proc.stdout).text()).trim();
			if (branch === "main" || branch === "master" || branch === "develop") {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	return "main";
}

/**
 * Serialize an MycofleetConfig to YAML format.
 *
 * Handles nested objects with indentation, scalar values,
 * arrays with `- item` syntax, and empty arrays as `[]`.
 */
function serializeConfigToYaml(config: MycofleetConfig): string {
	const lines: string[] = [];
	lines.push("# Mycofleet configuration");
	lines.push("# See: https://github.com/mycofleet/mycofleet");
	lines.push("");

	serializeObject(config as unknown as Record<string, unknown>, lines, 0);

	return `${lines.join("\n")}\n`;
}

/**
 * Recursively serialize an object to YAML lines.
 */
function serializeObject(obj: Record<string, unknown>, lines: string[], depth: number): void {
	const indent = "  ".repeat(depth);

	for (const [key, value] of Object.entries(obj)) {
		if (value === null || value === undefined) {
			lines.push(`${indent}${key}: null`);
		} else if (typeof value === "object" && !Array.isArray(value)) {
			lines.push(`${indent}${key}:`);
			serializeObject(value as Record<string, unknown>, lines, depth + 1);
		} else if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${indent}${key}: []`);
			} else {
				lines.push(`${indent}${key}:`);
				const itemIndent = "  ".repeat(depth + 1);
				for (const item of value) {
					lines.push(`${itemIndent}- ${formatYamlValue(item)}`);
				}
			}
		} else {
			lines.push(`${indent}${key}: ${formatYamlValue(value)}`);
		}
	}
}

/**
 * Format a scalar value for YAML output.
 */
function formatYamlValue(value: unknown): string {
	if (typeof value === "string") {
		// Quote strings that could be misinterpreted
		if (
			value === "" ||
			value === "true" ||
			value === "false" ||
			value === "null" ||
			value.includes(":") ||
			value.includes("#") ||
			value.includes("'") ||
			value.includes('"') ||
			value.includes("\n") ||
			/^\d/.test(value)
		) {
			// Use double quotes, escaping inner double quotes
			return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (value === null || value === undefined) {
		return "null";
	}

	return String(value);
}

/**
 * Build the starter agent manifest.
 */
function buildAgentManifest(): AgentManifest {
	const agents: AgentManifest["agents"] = {
		scout: {
			file: "scout.md",
			model: "haiku",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["explore", "research"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		builder: {
			file: "builder.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["implement", "refactor", "fix"],
			canSpawn: false,
			constraints: [],
		},
		reviewer: {
			file: "reviewer.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "validate"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		lead: {
			file: "lead.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "implement", "review"],
			canSpawn: true,
			constraints: [],
		},
		merger: {
			file: "merger.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["merge", "resolve-conflicts"],
			canSpawn: false,
			constraints: [],
		},
		coordinator: {
			file: "coordinator.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["coordinate", "dispatch", "escalate"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		supervisor: {
			file: "supervisor.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "supervise"],
			canSpawn: true,
			constraints: [],
		},
		monitor: {
			file: "monitor.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["monitor", "patrol"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
	};

	// Build capability index: map each capability to agent names that declare it
	const capabilityIndex: Record<string, string[]> = {};
	for (const [name, def] of Object.entries(agents)) {
		for (const cap of def.capabilities) {
			const existing = capabilityIndex[cap];
			if (existing) {
				existing.push(name);
			} else {
				capabilityIndex[cap] = [name];
			}
		}
	}

	return { version: "1.0", agents, capabilityIndex };
}

/**
 * Build the hooks.json content for the project orchestrator.
 *
 * Always generates from scratch (not from the agent template, which contains
 * {{AGENT_NAME}} placeholders and space indentation). Uses tab indentation
 * to match Biome formatting rules.
 */
function buildHooksJson(): string {
	// Tool name extraction: reads hook stdin JSON and extracts tool_name field.
	// Claude Code sends {"tool_name":"Bash","tool_input":{...}} on stdin for
	// PreToolUse/PostToolUse hooks.
	const toolNameExtract =
		'read -r INPUT; TOOL_NAME=$(echo "$INPUT" | sed \'s/.*"tool_name": *"\\([^"]*\\)".*/\\1/\');';

	const hooks = {
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "mycofleet prime --agent orchestrator",
						},
					],
				},
			],
			UserPromptSubmit: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "mycofleet mail check --inject --agent orchestrator",
						},
					],
				},
			],
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command:
								'read -r INPUT; CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\'); if echo "$CMD" | grep -qE \'\\bgit\\s+push\\b\'; then echo \'{"decision":"block","reason":"git push is blocked by mycofleet — merge locally, push manually when ready"}\'; exit 0; fi;',
						},
					],
				},
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} mycofleet log tool-start --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
			],
			PostToolUse: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} mycofleet log tool-end --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
			],
			Stop: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "mycofleet log session-end --agent orchestrator",
						},
						{
							type: "command",
							command: "mulch learn",
						},
						{
							type: "command",
							command: "sh",
								args: [
									"-lc",
									// biome-ignore lint/suspicious/noTemplateCurlyInString: Shell parameter expansion is intentional in hook command.
									'if [ -n "$OVERSTORY_AGENT_NAME" ]; then mulch learn --since "${OVERSTORY_SESSION_START_ISO:-}" >/dev/null 2>&1 || true; fi',
								],
						},
					],
				},
			],
			PreCompact: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "mycofleet prime --agent orchestrator --compact",
						},
					],
				},
			],
		},
	};

	return `${JSON.stringify(hooks, null, "\t")}\n`;
}

/**
 * Migrate existing SQLite databases on --force reinit.
 *
 * Opens each DB, enables WAL mode, and re-runs CREATE TABLE/INDEX IF NOT EXISTS
 * to apply any schema additions without losing existing data.
 */
async function migrateExistingDatabases(mycofleetPath: string): Promise<string[]> {
	const migrated: string[] = [];

	// Migrate mail.db
	const mailDbPath = join(mycofleetPath, "mail.db");
	if (await Bun.file(mailDbPath).exists()) {
		const db = new Database(mailDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status',
  priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
		db.exec(`
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id)`);
		db.close();
		migrated.push("mail.db");
	}

	// Migrate metrics.db
	const metricsDbPath = join(mycofleetPath, "metrics.db");
	if (await Bun.file(metricsDbPath).exists()) {
		const db = new Database(metricsDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  agent_name TEXT NOT NULL,
  bead_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  merge_result TEXT,
  parent_agent TEXT,
  PRIMARY KEY (agent_name, bead_id)
)`);
		db.close();
		migrated.push("metrics.db");
	}

	return migrated;
}

/**
 * Content for .overstory/.gitignore — runtime state that should not be tracked.
 * Uses wildcard+whitelist pattern: ignore everything, whitelist tracked files.
 * Auto-healed by mycofleet prime on each session start.
 * Config files (config.yaml, agent-manifest.json, hooks.json) remain tracked.
 */
export const MYCOFLEET_GITIGNORE = `# Wildcard+whitelist: ignore everything, whitelist tracked files
# Auto-healed by mycofleet prime on each session start
*
!.gitignore
!config.yaml
!agent-manifest.json
!hooks.json
!groups.json
!agent-defs/
`;

// Back-compat for tests during rebrand:
export const OVERSTORY_GITIGNORE = MYCOFLEET_GITIGNORE;

/**
 * Write .overstory/.gitignore for runtime state files.
 * Always overwrites to support --force reinit and auto-healing via prime.
 */
export async function writeMycofleetGitignore(mycofleetPath: string): Promise<void> {
	const gitignorePath = join(mycofleetPath, ".gitignore");
	await Bun.write(gitignorePath, MYCOFLEET_GITIGNORE);
}

/**
 * Print a success status line.
 */
function printCreated(relativePath: string): void {
	process.stdout.write(`  \u2713 Created ${relativePath}\n`);
}

/**
 * Entry point for `mycofleet init [--force]`.
 *
 * Scaffolds the .overstory/ directory structure in the current working directory.
 *
 * @param args - CLI arguments after "init" subcommand
 */
const INIT_HELP = `mycofleet init — Initialize .overstory/ in current project

Usage: mycofleet init [--force]

Options:
  --force      Reinitialize even if .overstory/ already exists
  --help, -h   Show this help`;

export async function initCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${INIT_HELP}\n`);
		return;
	}

	const force = args.includes("--force");
	const projectRoot = process.cwd();
	const mycofleetPath = join(projectRoot, MYCOFLEET_DIR);

	// 0. Verify we're inside a git repository
	const gitCheck = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
		cwd: projectRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const gitCheckExit = await gitCheck.exited;
	if (gitCheckExit !== 0) {
		throw new ValidationError("mycofleet requires a git repository. Run 'git init' first.", {
			field: "git",
		});
	}

	// 1. Check if .overstory/ already exists
	const existingDir = Bun.file(join(mycofleetPath, "config.yaml"));
	if (await existingDir.exists()) {
		if (!force) {
			process.stdout.write(
				"Warning: .overstory/ already initialized in this project.\n" +
					"Use --force to reinitialize.\n",
			);
			return;
		}
		process.stdout.write("Reinitializing .overstory/ (--force)\n\n");
	}

	// 2. Detect project info
	const projectName = await detectProjectName(projectRoot);
	const canonicalBranch = await detectCanonicalBranch(projectRoot);

	process.stdout.write(`Initializing mycofleet for "${projectName}"...\n\n`);

	// 3. Create directory structure
	const dirs = [
		MYCOFLEET_DIR,
		join(MYCOFLEET_DIR, "agents"),
		join(MYCOFLEET_DIR, "agent-defs"),
		join(MYCOFLEET_DIR, "worktrees"),
		join(MYCOFLEET_DIR, "specs"),
		join(MYCOFLEET_DIR, "logs"),
	];

	for (const dir of dirs) {
		await mkdir(join(projectRoot, dir), { recursive: true });
		printCreated(`${dir}/`);
	}

	// 3b. Deploy agent definition .md files from mycofleet install directory
	const mycofleetAgentsDir = join(import.meta.dir, "..", "..", "agents");
	const agentDefsTarget = join(mycofleetPath, "agent-defs");
	const agentDefFiles = await readdir(mycofleetAgentsDir);
	for (const fileName of agentDefFiles) {
		if (!fileName.endsWith(".md")) continue;
		const source = Bun.file(join(mycofleetAgentsDir, fileName));
		const content = await source.text();
		await Bun.write(join(agentDefsTarget, fileName), content);
		printCreated(`${MYCOFLEET_DIR}/agent-defs/${fileName}`);
	}

	// 4. Write config.yaml
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = projectName;
	config.project.root = projectRoot;
	config.project.canonicalBranch = canonicalBranch;

	const configYaml = serializeConfigToYaml(config);
	const configPath = join(mycofleetPath, "config.yaml");
	await Bun.write(configPath, configYaml);
	printCreated(`${MYCOFLEET_DIR}/config.yaml`);

	// 5. Write agent-manifest.json
	const manifest = buildAgentManifest();
	const manifestPath = join(mycofleetPath, "agent-manifest.json");
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	printCreated(`${MYCOFLEET_DIR}/agent-manifest.json`);

	// 6. Write hooks.json
	const hooksContent = buildHooksJson();
	const hooksPath = join(mycofleetPath, "hooks.json");
	await Bun.write(hooksPath, hooksContent);
	printCreated(`${MYCOFLEET_DIR}/hooks.json`);

	// 7. Write .overstory/.gitignore for runtime state
	await writeMycofleetGitignore(mycofleetPath);
	printCreated(`${MYCOFLEET_DIR}/.gitignore`);

	// 8. Migrate existing SQLite databases on --force reinit
	if (force) {
		const migrated = await migrateExistingDatabases(mycofleetPath);
		for (const dbName of migrated) {
			process.stdout.write(`  \u2713 Migrated ${MYCOFLEET_DIR}/${dbName} (schema validated)\n`);
		}
	}

	process.stdout.write("\nDone.\n");
	process.stdout.write("  Next: run `mycofleet hooks install` to enable Claude Code hooks.\n");
	process.stdout.write("  Then: run `mycofleet status` to see the current state.\n");
}
