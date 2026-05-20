#!/usr/bin/env npx tsx
/**
 * Showcase launching pi from this checkout on a generic bash task.
 *
 * Usage:
 *   npx tsx scripts/showcase-pi-bash-task.ts [options]
 *
 * Options:
 *   --model <pattern>       Pass a model pattern to pi, for example "sonnet" or "openai/gpt-4o"
 *   --provider <name>       Pass a provider to pi, for example "anthropic" or "openai"
 *   --demo-dir <path>       Use an existing or explicit demo directory
 *   --keep                  Keep the demo directory after exit
 *   --no-run                Create the workspace and print commands without calling pi
 *   --no-text               Skip the text one-shot run
 *   --no-json               Skip the JSON event stream run
 *   --no-tmux               Skip the interactive tmux run
 *   --help                  Show this help
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";

interface Options {
	model?: string;
	provider?: string;
	demoRoot?: string;
	keep: boolean;
	runLive: boolean;
	runText: boolean;
	runJson: boolean;
	runTmux: boolean;
}

interface SessionHeader {
	type?: string;
	id?: string;
	cwd?: string;
}

interface SessionMessage {
	role?: string;
	toolName?: string;
	content?: JsonContent[];
}

interface SessionEntry {
	type?: string;
	message?: SessionMessage;
}

interface JsonContent {
	type?: string;
	text?: string;
}

interface JsonEvent {
	type?: string;
	id?: string;
	cwd?: string;
	message?: SessionMessage;
	toolName?: string;
	args?: unknown;
	isError?: boolean;
	steering?: unknown[];
	followUp?: unknown[];
	reason?: string;
}

const usage = `Showcase launching pi from this checkout on a generic bash task.

Usage:
  npx tsx scripts/showcase-pi-bash-task.ts [options]

Options:
  --model <pattern>       Pass a model pattern to pi, for example "sonnet" or "openai/gpt-4o"
  --provider <name>       Pass a provider to pi, for example "anthropic" or "openai"
  --demo-dir <path>       Use an existing or explicit demo directory
  --keep                  Keep the demo directory after exit
  --no-run                Create the workspace and print commands without calling pi
  --no-text               Skip the text one-shot run
  --no-json               Skip the JSON event stream run
  --no-tmux               Skip the interactive tmux run
  --help                  Show this help`;

const task = `Use bash to inspect this directory. Count files, count log levels in app.log,
sum the inventory counts in inventory.csv, and write report.txt with:
1. the commands you ran
2. the computed facts
3. one short recommendation
Do not modify files other than report.txt.`;

const interactiveTask = `Use bash to inspect this directory and write report.txt. Start by running a
visible progress loop that prints five steps with a one-second sleep between
steps, then compute file counts, app.log level counts, and the inventory total.`;

function parseArgs(argv: string[]): Options {
	const options: Options = {
		keep: false,
		runLive: true,
		runText: true,
		runJson: true,
		runTmux: true,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--model":
				options.model = requireValue(argv, ++i, "--model");
				break;
			case "--provider":
				options.provider = requireValue(argv, ++i, "--provider");
				break;
			case "--demo-dir":
				options.demoRoot = requireValue(argv, ++i, "--demo-dir");
				break;
			case "--keep":
				options.keep = true;
				break;
			case "--no-run":
				options.runLive = false;
				break;
			case "--no-text":
				options.runText = false;
				break;
			case "--no-json":
				options.runJson = false;
				break;
			case "--no-tmux":
				options.runTmux = false;
				break;
			case "--help":
			case "-h":
				console.log(usage);
				process.exit(0);
				break;
			default:
				die(`unknown option: ${arg}`);
		}
	}

	if (!options.runLive) {
		options.keep = true;
	}

	return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value) {
		die(`${flag} requires a value`);
	}
	return value;
}

function die(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

function info(message: string): void {
	console.log(`\n==> ${message}`);
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatCommand(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

function commandLines(workspace: string, piFromSource: string, piArgs: string[], args: string[]): string[] {
	return [`cd ${shellQuote(workspace)}`, formatCommand(["PI_TELEMETRY=0", piFromSource, ...piArgs, ...args])];
}

function createDemoWorkspace(workspace: string): void {
	mkdirSync(workspace, { recursive: true });
	writeFileSync(
		join(workspace, "README.md"),
		`# Pi Bash Showcase Workspace

This directory is intentionally small. The agent should inspect it with bash,
summarize the data, and write a concise report.
`,
	);
	writeFileSync(
		join(workspace, "inventory.csv"),
		`item,count
alpha,3
beta,8
gamma,13
delta,21
`,
	);
	writeFileSync(
		join(workspace, "app.log"),
		`2026-05-18T09:00:00Z INFO started job=demo
2026-05-18T09:00:01Z INFO loaded inventory rows=4
2026-05-18T09:00:02Z WARN beta count is above threshold
2026-05-18T09:00:03Z ERROR gamma needs review
2026-05-18T09:00:04Z INFO finished job=demo
`,
	);
}

function latestSessionFile(sessionDir: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	return readdirSync(sessionDir)
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(sessionDir, file))
		.filter((file) => statSync(file).isFile())
		.sort()
		.at(-1);
}

function summarizeSessionFile(file: string): void {
	if (!existsSync(file)) return;

	const lines = readFileSyncUtf8(file)
		.trim()
		.split("\n")
		.filter(Boolean);
	const entries = lines.map((line) => JSON.parse(line) as SessionEntry | SessionHeader);
	const header = entries[0] as SessionHeader | undefined;
	const counts = new Map<string, number>();
	const roles = new Map<string, number>();
	const tools = new Map<string, number>();

	for (const entry of entries.slice(1) as SessionEntry[]) {
		const entryType = entry.type ?? "unknown";
		counts.set(entryType, (counts.get(entryType) ?? 0) + 1);
		if (entry.type !== "message") continue;
		const role = entry.message?.role ?? "unknown";
		roles.set(role, (roles.get(role) ?? 0) + 1);
		if (role === "toolResult") {
			const toolName = entry.message?.toolName ?? "unknown";
			tools.set(toolName, (tools.get(toolName) ?? 0) + 1);
		}
	}

	console.log(`session file: ${file}`);
	console.log(`session id:   ${header?.id ?? "unknown"}`);
	console.log(`cwd:          ${header?.cwd ?? "unknown"}`);
	console.log(`entries:      ${entries.length}`);
	console.log(`entry types:  ${formatMap(counts)}`);
	console.log(`roles:        ${formatMap(roles)}`);
	console.log(`tools:        ${formatMap(tools)}`);
}

function readFileSyncUtf8(path: string): string {
	return readFileSync(path, "utf8");
}

function formatMap(map: Map<string, number>): string {
	const entries = [...map.entries()];
	if (entries.length === 0) return "none";
	return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function textOf(message: SessionMessage | undefined): string {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text?.replace(/\s+/g, " ").trim() ?? "")
		.filter(Boolean)
		.join(" ");
}

function monitorJsonEvent(line: string): void {
	if (!line.trim()) return;

	let event: JsonEvent;
	try {
		event = JSON.parse(line) as JsonEvent;
	} catch {
		console.log(`[raw] ${line}`);
		return;
	}

	switch (event.type) {
		case "session":
			console.log(`[session] ${event.id ?? "unknown"} cwd=${event.cwd ?? "unknown"}`);
			break;
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
			console.log(`[${event.type}]`);
			break;
		case "message_start":
			console.log(`[message:start] role=${event.message?.role ?? "unknown"}`);
			break;
		case "message_end": {
			const text = textOf(event.message);
			const suffix = text ? ` text="${text.slice(0, 140)}${text.length > 140 ? "..." : ""}"` : "";
			console.log(`[message:end] role=${event.message?.role ?? "unknown"}${suffix}`);
			break;
		}
		case "tool_execution_start":
			console.log(`[tool:start] ${event.toolName ?? "unknown"} args=${JSON.stringify(event.args)}`);
			break;
		case "tool_execution_end":
			console.log(`[tool:end] ${event.toolName ?? "unknown"} isError=${event.isError ?? false}`);
			break;
		case "queue_update":
			console.log(`[queue] steering=${event.steering?.length ?? 0} followUp=${event.followUp?.length ?? 0}`);
			break;
		case "compaction_start":
		case "compaction_end":
			console.log(`[${event.type}] reason=${event.reason ?? "unknown"}`);
			break;
		default:
			break;
	}
}

async function runPiText(
	workspace: string,
	logPath: string,
	piFromSource: string,
	piArgs: string[],
	args: string[],
): Promise<number> {
	const child = spawn(piFromSource, [...piArgs, ...args], {
		cwd: workspace,
		env: { ...process.env, PI_TELEMETRY: "0" },
		stdio: ["ignore", "pipe", "inherit"],
	});
	const log = createWriteStream(logPath);
	child.stdout.on("data", (chunk: Buffer) => {
		process.stdout.write(chunk);
		log.write(chunk);
	});
	const status = await waitForChild(child);
	log.end();
	return status;
}

async function runPiJson(
	workspace: string,
	jsonLogPath: string,
	stderrLogPath: string,
	piFromSource: string,
	piArgs: string[],
	args: string[],
): Promise<number> {
	const child = spawn(piFromSource, [...piArgs, ...args], {
		cwd: workspace,
		env: { ...process.env, PI_TELEMETRY: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const jsonLog = createWriteStream(jsonLogPath);
	const stderrLog = createWriteStream(stderrLogPath);
	const lines = createInterface({ input: child.stdout });

	lines.on("line", (line) => {
		jsonLog.write(`${line}\n`);
		monitorJsonEvent(line);
	});
	child.stderr.on("data", (chunk: Buffer) => stderrLog.write(chunk));

	const status = await waitForChild(child);
	lines.close();
	jsonLog.end();
	stderrLog.end();
	return status;
}

function waitForChild(child: ChildProcess): Promise<number> {
	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

function printStorageNotes(workspace: string, sessionDir: string, logDir: string): void {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

	info("Storage map");
	console.log(`demo workspace:      ${workspace}`);
	console.log(`demo session dir:    ${sessionDir}`);
	console.log(`demo logs:           ${logDir}`);
	console.log(`global config dir:   ${agentDir}`);
	console.log(`auth file:           ${join(agentDir, "auth.json")}`);
	console.log(`settings file:       ${join(agentDir, "settings.json")}`);
	console.log(`custom models file:  ${join(agentDir, "models.json")}`);
	console.log(`default sessions:    ${join(agentDir, "sessions", "<encoded-cwd>", "*.jsonl")}`);
	console.log(`project config:      ${join(workspace, ".pi", "settings.json")}, prompts, skills, themes, extensions`);
	console.log(
		"\nThis demo passes --session-dir, so session JSONL is written under the demo directory instead of the default path.",
	);
}

function printFeatureCommands(
	workspace: string,
	demoRoot: string,
	piFromSource: string,
	piArgs: string[],
	latestSession: string | undefined,
): void {
	info("Useful commands to rerun or extend the demo");
	console.log("one-shot text:");
	printIndentedCommand(workspace, piFromSource, piArgs, ["-p", task]);

	console.log("\nJSON event stream:");
	printIndentedCommand(workspace, piFromSource, piArgs, ["--mode", "json", task]);

	console.log("\nread-only review mode:");
	printIndentedCommand(workspace, piFromSource, piArgs, [
		"--tools",
		"read,grep,find,ls",
		"-p",
		"Review this workspace without changing files.",
	]);

	console.log("\nephemeral mode, no session file:");
	printIndentedCommand(workspace, piFromSource, piArgs, ["--no-session", "-p", "Inspect the workspace and summarize it."]);

	if (latestSession) {
		console.log("\nresume exact session:");
		printIndentedCommand(workspace, piFromSource, piArgs, ["--session", latestSession, "What did you do in this session?"]);

		console.log("\nfork exact session:");
		printIndentedCommand(workspace, piFromSource, piArgs, [
			"--fork",
			latestSession,
			"Continue from that session, but produce a shorter report.",
		]);

		console.log("\nexport session to HTML:");
		printIndentedCommand(workspace, piFromSource, piArgs, ["--export", latestSession, join(demoRoot, "session.html")]);
	}

	console.log("\nRPC mode for integrations:");
	printIndentedCommand(workspace, piFromSource, piArgs, ["--mode", "rpc"]);
	console.log('  # then send JSONL commands on stdin, for example: {"type":"get_state"}');
}

function printIndentedCommand(workspace: string, piFromSource: string, piArgs: string[], args: string[]): void {
	for (const line of commandLines(workspace, piFromSource, piArgs, args)) {
		console.log(`  ${line}`);
	}
}

function commandExists(command: string): boolean {
	const result = spawnSync(command, ["-V"], { stdio: "ignore" });
	return result.status === 0;
}

function runTmux(args: string[]): SpawnSyncReturns<string> {
	return spawnSync("tmux", args, { encoding: "utf8" });
}

function tmuxHasSession(sessionName: string): boolean {
	return runTmux(["has-session", "-t", sessionName]).status === 0;
}

function tmuxKillSession(sessionName: string): void {
	if (tmuxHasSession(sessionName)) {
		runTmux(["kill-session", "-t", sessionName]);
	}
}

function captureTmuxPane(sessionName: string): string {
	const result = runTmux(["capture-pane", "-t", sessionName, "-p"]);
	return result.stdout ?? "";
}

function printFirstLines(text: string, maxLines: number): void {
	for (const line of text.split("\n").slice(0, maxLines)) {
		console.log(line);
	}
}

async function runInteractiveTmux(
	workspace: string,
	demoRoot: string,
	piFromSource: string,
	piArgs: string[],
): Promise<string | undefined> {
	if (!commandExists("tmux")) {
		info("tmux not found; skipping interactive TUI run");
		console.log("Install tmux or rerun without --no-run on a machine that has tmux.");
		return undefined;
	}

	const sessionName = `pi-showcase-${process.pid}`;
	const tmuxCommand = formatCommand(["env", "PI_TELEMETRY=0", piFromSource, ...piArgs, interactiveTask]);

	info("Interactive TUI run in tmux");
	tmuxKillSession(sessionName);
	const result = runTmux(["new-session", "-d", "-s", sessionName, "-x", "100", "-y", "30", "-c", workspace, tmuxCommand]);
	if (result.status !== 0) {
		console.error(result.stderr || "failed to start tmux session");
		return undefined;
	}

	console.log(`started tmux session: ${sessionName}`);
	await sleep(5000);
	console.log("\ninitial pane snapshot:");
	printFirstLines(captureTmuxPane(sessionName), 30);

	console.log("\nqueueing a steering message to demonstrate intervention");
	runTmux(["send-keys", "-t", sessionName, "Steering: keep report.txt under 15 lines and do not create extra files.", "Enter"]);
	await sleep(2000);
	console.log("\nafter steering snapshot:");
	printFirstLines(captureTmuxPane(sessionName), 30);

	printTmuxHelp(sessionName, demoRoot);
	return sessionName;
}

function printTmuxHelp(sessionName: string, demoRoot: string): void {
	info("Interactive tmux controls");
	console.log(`attach to the live TUI:\n  tmux attach -t ${shellQuote(sessionName)}`);
	console.log(`watch without attaching:\n  tmux capture-pane -t ${shellQuote(sessionName)} -p`);
	console.log(
		`send a steering message while pi is working:\n  tmux send-keys -t ${shellQuote(sessionName)} ${shellQuote(
			"Steering: keep report.txt under 15 lines and do not create extra files.",
		)} Enter`,
	);
	console.log(`abort the current agent turn:\n  tmux send-keys -t ${shellQuote(sessionName)} Escape`);
	console.log(`show session metadata in the TUI:\n  tmux send-keys -t ${shellQuote(sessionName)} /session Enter`);
	console.log(`open the session tree:\n  tmux send-keys -t ${shellQuote(sessionName)} /tree Enter`);
	console.log(
		`export from the TUI:\n  tmux send-keys -t ${shellQuote(sessionName)} ${shellQuote(
			`/export ${join(demoRoot, "tmux-session.html")}`,
		)} Enter`,
	);
	console.log(`stop the demo session:\n  tmux kill-session -t ${shellQuote(sessionName)}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function listFiles(root: string, maxDepth: number): string[] {
	const results: string[] = [];

	function walk(current: string, depth: number): void {
		if (depth > maxDepth || !existsSync(current)) return;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isFile()) {
				results.push(path);
			} else if (entry.isDirectory()) {
				walk(path, depth + 1);
			}
		}
	}

	walk(root, 0);
	return results.sort();
}

async function assertExecutable(path: string, label: string): Promise<void> {
	try {
		await access(path, constants.X_OK);
	} catch {
		die(`${label} is missing or not executable at ${path}`);
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = resolve(scriptDir, "..");
	const piFromSource = join(repoRoot, "pi-test.sh");
	const localTsx = join(repoRoot, "node_modules", ".bin", "tsx");

	await assertExecutable(piFromSource, "pi-test.sh");
	await assertExecutable(localTsx, "tsx");

	const demoRoot = resolve(options.demoRoot ?? join(tmpdir(), `pi-showcase-${formatDateForPath(new Date())}`));
	const workspace = join(demoRoot, "workspace");
	const sessionDir = join(demoRoot, "sessions");
	const logDir = join(demoRoot, "logs");

	mkdirSync(workspace, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });
	createDemoWorkspace(workspace);

	const piArgs = ["--offline", "--session-dir", sessionDir];
	if (options.provider) {
		piArgs.push("--provider", options.provider);
	}
	if (options.model) {
		piArgs.push("--model", options.model);
	}

	let tmuxSession: string | undefined;
	const cleanup = (): void => {
		if (options.keep) return;
		if (tmuxSession) {
			tmuxKillSession(tmuxSession);
		}
		rmSync(demoRoot, { recursive: true, force: true });
	};

	process.on("SIGINT", () => {
		cleanup();
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(143);
	});

	printStorageNotes(workspace, sessionDir, logDir);

	if (!options.runLive) {
		info("Dry run only");
		printFeatureCommands(workspace, demoRoot, piFromSource, piArgs, undefined);
		if (options.runTmux) {
			printTmuxHelp("pi-showcase", demoRoot);
		}
		info("Kept demo directory");
		console.log(demoRoot);
		return;
	}

	if (options.runText) {
		info("Text one-shot run");
		console.log("command:");
		printIndentedCommand(workspace, piFromSource, piArgs, ["-p", task]);
		const status = await runPiText(workspace, join(logDir, "text-output.txt"), piFromSource, piArgs, ["-p", task]);
		if (status !== 0) {
			console.log(`\ntext run exited with status ${status}; continuing so the rest of the showcase is still visible`);
		}
	}

	if (options.runJson) {
		info("JSON event stream run with live monitor");
		const jsonLog = join(logDir, "events.jsonl");
		const stderrLog = join(logDir, "events.stderr.log");
		console.log(`raw JSONL: ${jsonLog}`);
		console.log(`stderr:    ${stderrLog}`);
		console.log("command:");
		printIndentedCommand(workspace, piFromSource, piArgs, ["--mode", "json", task]);
		const status = await runPiJson(workspace, jsonLog, stderrLog, piFromSource, piArgs, ["--mode", "json", task]);
		if (status !== 0) {
			console.log(`\nJSON run exited with status ${status}. See ${stderrLog} for stderr.`);
		}
	}

	const firstLatest = latestSessionFile(sessionDir);
	if (firstLatest) {
		info("Session JSONL summary");
		summarizeSessionFile(firstLatest);
	}

	if (options.runTmux) {
		tmuxSession = await runInteractiveTmux(workspace, demoRoot, piFromSource, piArgs);
		if (tmuxSession && !options.keep) {
			console.log("\nAttach from another terminal now, or rerun with --keep if you want the tmux session and demo directory to survive script exit.");
		}
	}

	printFeatureCommands(workspace, demoRoot, piFromSource, piArgs, latestSessionFile(sessionDir));

	info("Demo artifacts");
	for (const file of listFiles(demoRoot, 3)) {
		console.log(file);
	}

	if (options.keep) {
		info("Kept demo directory");
		console.log(demoRoot);
		return;
	}

	if (tmuxSession && process.stdin.isTTY) {
		info("Interactive pause");
		process.stdout.write("Press Enter to stop the tmux session and remove the demo directory.");
		await new Promise<void>((resolveInput) => process.stdin.once("data", () => resolveInput()));
	}

	info("Cleanup");
	console.log("Demo directory will be removed on exit. Rerun with --keep to inspect artifacts after the script exits.");
	cleanup();
}

function formatDateForPath(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
		date.getMinutes(),
	)}${pad(date.getSeconds())}`;
}

await main();
