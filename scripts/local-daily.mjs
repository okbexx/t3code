import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { localDesktop } from "../packages/shared/src/localDesktop.ts";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const appPath = `/Applications/${localDesktop.name}.app`;
const releaseRoot = NodePath.join(root, "release", "local");
const manifestPath = NodePath.join(releaseRoot, "latest.json");
const command = process.argv[2] ?? "help";

function run(binary, args, { cwd = root, capture = false } = {}) {
  const result = NodeChildProcess.spawnSync(binary, args, {
    cwd,
    env: { ...process.env, VP_NODE_VERSION: "24.20.0" },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${binary} ${args.join(" ")} failed (${result.status ?? result.signal}).${capture ? `\n${result.stderr}` : ""}`,
    );
  }
  return capture ? result.stdout.trim() : undefined;
}

const git = (...args) => run("git", args, { capture: true });
const stamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);

function requireDailyBranch() {
  if (git("branch", "--show-current") !== "local/daily") {
    throw new Error("Run this command from the local/daily worktree.");
  }
  if (git("status", "--porcelain")) {
    throw new Error("Commit or stash worktree changes before syncing or building.");
  }
}

function plist(bundle, key) {
  return run(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, NodePath.join(bundle, "Contents", "Info.plist")],
    { capture: true },
  );
}

function validateApp(bundle, version) {
  if (plist(bundle, "CFBundleIdentifier") !== localDesktop.appId) {
    throw new Error(`Refusing a bundle with the wrong application identity: ${bundle}`);
  }
  if (version && plist(bundle, "CFBundleShortVersionString") !== version) {
    throw new Error("The app version does not match the build manifest.");
  }
  if (NodeFS.existsSync(NodePath.join(bundle, "Contents", "Resources", "app-update.yml"))) {
    throw new Error("Local builds must not contain an automatic update feed.");
  }
}

function sync() {
  requireDailyBranch();
  run("git", ["fetch", "--tags", "upstream", "main"]);
  const [ahead] = git("rev-list", "--left-right", "--count", "main...upstream/main")
    .split(/\s+/)
    .map(Number);
  if (ahead !== 0) throw new Error("main contains local commits; resolve that before syncing.");
  const mainWorktree = git("worktree", "list", "--porcelain")
    .split("\n\n")
    .find(
      (entry) =>
        entry.includes("branch refs/heads/main\n") || entry.endsWith("branch refs/heads/main"),
    );
  if (mainWorktree) {
    const path = mainWorktree.split("\n")[0].slice("worktree ".length);
    if (run("git", ["status", "--porcelain"], { cwd: path, capture: true })) {
      throw new Error("The main worktree has uncommitted changes.");
    }
    run("git", ["merge", "--ff-only", "--no-stat", "upstream/main"], { cwd: path });
  } else {
    run("git", [
      "update-ref",
      "refs/heads/main",
      git("rev-parse", "upstream/main"),
      git("rev-parse", "main"),
    ]);
  }
  run("git", ["push", "origin", "main"]);
  run("git", ["merge", "--no-edit", "--no-stat", "upstream/main"]);
}

function check() {
  const paths = git("diff", "--name-only", "--diff-filter=ACMR", "upstream/main...HEAD")
    .split("\n")
    .filter((path) => /\.(?:ts|tsx|mjs)$/.test(path));
  if (paths.length) run("vp", ["lint", ...paths]);
  run("vp", [
    "run",
    "--filter",
    "@t3tools/desktop",
    "--filter",
    "@t3tools/shared",
    "--filter",
    "@t3tools/contracts",
    "--filter",
    "@t3tools/client-runtime",
    "--filter",
    "@t3tools/web",
    "--filter",
    "t3",
    "typecheck",
  ]);
}

function build() {
  requireDailyBranch();
  run("vp", ["install", "--frozen-lockfile"]);
  check();
  const sourceCommit = git("rev-parse", "HEAD");
  const upstreamCommit = git("merge-base", "HEAD", "upstream/main");
  const upstreamTag = git("describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", upstreamCommit);
  const baseVersion = /^v?(\d+\.\d+\.\d+)/.exec(upstreamTag)?.[1];
  if (!baseVersion) throw new Error(`Cannot resolve a version from ${upstreamTag}.`);
  const version = `${baseVersion}-local.${stamp()}.g${sourceCommit.slice(0, 8)}`;
  const outputDir = NodePath.join(releaseRoot, version);
  NodeFS.mkdirSync(outputDir, { recursive: true });
  run(process.execPath, [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--target",
    "zip",
    "--arch",
    "arm64",
    "--build-version",
    version,
    "--output-dir",
    outputDir,
  ]);
  const builtApp = NodePath.join(outputDir, "mac-arm64", `${localDesktop.name}.app`);
  validateApp(builtApp, version);
  const manifest = {
    version,
    sourceCommit,
    upstreamCommit,
    upstreamTag,
    builtApp,
    appId: localDesktop.appId,
    builtAt: new Date().toISOString(),
  };
  NodeFS.writeFileSync(
    NodePath.join(outputDir, "build.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  NodeFS.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built ${version}\n${builtApp}`);
}

function install() {
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  validateApp(manifest.builtApp, manifest.version);
  if (NodeFS.existsSync(appPath)) validateApp(appPath);
  const installStamp = stamp();
  const stagedApp = `/Applications/.T3-Code-Local-${installStamp}.app`;
  if (NodeFS.existsSync(stagedApp)) throw new Error(`Install staging already exists: ${stagedApp}`);
  run("ditto", [manifest.builtApp, stagedApp]);
  validateApp(stagedApp, manifest.version);
  // Target only the local bundle; never quit the official app hosting this agent.
  let backupApp;
  if (NodeFS.existsSync(appPath)) {
    run("osascript", [
      "-e",
      `if application id "${localDesktop.appId}" is running then tell application id "${localDesktop.appId}" to quit`,
    ]);
    const deadline = Date.now() + 30_000;
    while (
      run("osascript", ["-e", `application id "${localDesktop.appId}" is running`], {
        capture: true,
      }) === "true"
    ) {
      if (Date.now() >= deadline)
        throw new Error("The local app has not finished quitting; installation stopped.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    const backupDir = NodePath.join(releaseRoot, "installed-backups", installStamp);
    NodeFS.mkdirSync(backupDir, { recursive: true });
    backupApp = NodePath.join(backupDir, `${localDesktop.name}.app`);
    NodeFS.renameSync(appPath, backupApp);
    console.log(`Previous app saved in ${backupDir}`);
  }
  try {
    NodeFS.renameSync(stagedApp, appPath);
  } catch (error) {
    if (backupApp && !NodeFS.existsSync(appPath)) NodeFS.renameSync(backupApp, appPath);
    throw error;
  }
  run("open", ["-a", appPath]);
  console.log(`Installed and launched ${appPath}`);
}

function status() {
  console.log(
    JSON.stringify(
      {
        branch: git("branch", "--show-current"),
        commit: git("rev-parse", "HEAD"),
        upstream: git("rev-parse", "upstream/main"),
        application: appPath,
        installedVersion: NodeFS.existsSync(appPath)
          ? plist(appPath, "CFBundleShortVersionString")
          : null,
        homeDirectory: localDesktop.homeDirectory,
        backendPort: localDesktop.backendPort,
      },
      null,
      2,
    ),
  );
}

try {
  switch (command) {
    case "sync":
      sync();
      break;
    case "check":
      check();
      break;
    case "build":
      build();
      break;
    case "install":
      install();
      break;
    case "update":
      sync();
      build();
      install();
      break;
    case "status":
      status();
      break;
    case "help":
      console.log(
        "Usage: scripts/local-daily <sync|check|build|install|update|status>\nupdate: sync upstream, check, build, install and launch the local app.",
      );
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
