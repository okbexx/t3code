import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const upstream = "pingdotgg/t3code";
const branchPrefix = "maint/";
const terminalEvents = new Set(["skipped", "merged", "closed"]);
const recordableEvents = new Set(["started", "pr", "skipped"]);
const candidateQuery = [
  `repo:${upstream} is:issue is:open label:bug label:accepted no:assignee`,
  '-label:"needs more info" -label:needs-triage -label:upstream',
  "-label:wontfix -label:duplicate -label:invalid sort:created-desc",
].join(" ");
const platformPattern = /\b(windows|wsl|linux|ubuntu|android|ios|iphone|ipad)\b/gi;
const [command = "help", ...args] = process.argv.slice(2);

function run(binary, argv) {
  const result = NodeChildProcess.spawnSync(binary, argv, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${binary} ${argv.join(" ")} failed (${result.status ?? result.signal}).\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

const git = (...argv) => run("git", argv);
const gh = (...argv) => run("gh", argv);
const ghJson = (...argv) => JSON.parse(gh(...argv));
const print = (value) => console.log(JSON.stringify(value, null, 2));

// Attempts are recorded beside the shared object store so every worktree sees the same
// history and nothing can be committed by accident.
const logPath = NodePath.join(
  git("rev-parse", "--path-format=absolute", "--git-common-dir"),
  "upstream-maint",
  "attempts.jsonl",
);

let cachedViewer;
const viewer = () => (cachedViewer ??= gh("api", "user", "--jq", ".login"));

let cachedMaintainers;
function maintainers() {
  cachedMaintainers ??= new Set(
    gh(
      "api",
      `repos/${upstream}/contents/.github/TRIAGE_EXEMPTIONS.td`,
      "-H",
      "Accept: application/vnd.github.raw",
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("github:"))
      .map((line) => line.slice("github:".length).toLowerCase()),
  );
  return cachedMaintainers;
}

function readLog() {
  if (!NodeFS.existsSync(logPath)) return [];
  return NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendLog(entry) {
  const record = { at: new Date().toISOString(), ...entry };
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
  NodeFS.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  return record;
}

function attempts() {
  const byIssue = new Map();
  for (const entry of readLog()) {
    const previous = entry.event === "started" ? {} : byIssue.get(entry.issue);
    byIssue.set(entry.issue, {
      ...previous,
      ...Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)),
      startedAt: previous?.startedAt ?? entry.at,
    });
  }
  return [...byIssue.values()];
}

const isActive = (attempt) => !terminalEvents.has(attempt.event);

function activity(pr) {
  const me = viewer();
  return [
    ...pr.comments.map((comment) => ({ ...comment, at: comment.createdAt })),
    ...pr.reviews
      .filter((review) => review.body || review.state !== "COMMENTED")
      .map((review) => ({ ...review, at: review.submittedAt })),
  ]
    .filter((item) => item.author?.login && item.author.login !== me)
    .sort((left, right) => left.at.localeCompare(right.at))
    .map((item) => ({
      author: item.author.login,
      maintainer: maintainers().has(item.author.login.toLowerCase()),
      at: item.at,
      ...(item.state ? { review: item.state } : {}),
      body: (item.body ?? "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim()
        .slice(0, 500),
    }));
}

function pullRequest(number) {
  const pr = ghJson(
    "pr",
    "view",
    String(number),
    "--repo",
    upstream,
    "--json",
    "number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup,labels,comments,reviews,updatedAt,mergedAt,closedAt",
  );
  const checks = {};
  for (const check of pr.statusCheckRollup ?? []) {
    const outcome = check.conclusion || check.state || check.status || "UNKNOWN";
    checks[outcome] = (checks[outcome] ?? 0) + 1;
  }
  const events = activity(pr);
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    reviewDecision: pr.reviewDecision || null,
    checks,
    labels: pr.labels.map((label) => label.name),
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt || null,
    closedAt: pr.closedAt || null,
    lastMaintainerComment: events.findLast((item) => item.maintainer) ?? null,
    recentActivity: events.slice(-5),
  };
}

function pullRequestForBranch(branch) {
  return ghJson(
    "pr",
    "list",
    "--repo",
    upstream,
    "--head",
    branch,
    "--author",
    "@me",
    "--state",
    "all",
    "--json",
    "number",
  )[0]?.number;
}

function status() {
  const active = [];
  const ended = [];
  for (const attempt of attempts().filter(isActive)) {
    let current = attempt;
    if (!current.pr && current.branch) {
      // A worker can open its pull request without recording it; adopt it here.
      const number = pullRequestForBranch(current.branch);
      if (number)
        current = { ...current, ...appendLog({ issue: current.issue, event: "pr", pr: number }) };
    }
    const pr = current.pr ? pullRequest(current.pr) : null;
    if (pr?.state === "MERGED" || pr?.state === "CLOSED") {
      const event = pr.state === "MERGED" ? "merged" : "closed";
      const closer = pr.lastMaintainerComment ?? pr.recentActivity.at(-1);
      const reason = event === "closed" ? closer?.body : undefined;
      appendLog({ issue: current.issue, event, pr: pr.number, reason });
      ended.push({ ...current, event, pull: pr });
    } else {
      active.push({ ...current, pull: pr });
    }
  }
  const tracked = new Set(active.map((attempt) => attempt.pr).filter(Boolean));
  const untracked = ghJson(
    "pr",
    "list",
    "--repo",
    upstream,
    "--author",
    "@me",
    "--state",
    "open",
    "--json",
    "number,url,title,headRefName",
  ).filter((pr) => pr.headRefName.startsWith(branchPrefix) && !tracked.has(pr.number));
  print({
    ready: active.length === 0 && untracked.length === 0,
    active,
    ended,
    untracked,
    recent: attempts()
      .filter((attempt) => !isActive(attempt))
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 5)
      .map(({ issue, event, pr, reason, at }) => ({ issue, event, pr, reason, at })),
    logPath,
  });
}

function searchIssues() {
  const query = `query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 50, after: $after) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue {
          number title url createdAt updatedAt bodyText
          labels(first: 20) { nodes { name } }
          comments { totalCount }
          reactions { totalCount }
          timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
            nodes {
              ... on CrossReferencedEvent { source { ...pr } }
              ... on ConnectedEvent { subject { ...pr } }
            }
          }
          closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { ...pr } }
        }
      }
    }
  }
  fragment pr on PullRequest { number state author { login } repository { nameWithOwner } }`;
  const issues = [];
  let after;
  for (let page = 0; page < 6; page += 1) {
    const result = ghJson(
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `q=${candidateQuery}`,
      ...(after ? ["-f", `after=${after}`] : []),
    ).data.search;
    issues.push(...result.nodes);
    if (!result.pageInfo.hasNextPage) break;
    after = result.pageInfo.endCursor;
  }
  return issues;
}

function candidates() {
  const me = viewer();
  const attempted = new Set(attempts().map((attempt) => attempt.issue));
  const excluded = { pullRequest: 0, attempted: 0 };
  const issues = searchIssues();
  const result = [];
  for (const issue of issues) {
    const pullRequests = [
      ...issue.timelineItems.nodes.map((node) => node.source ?? node.subject),
      ...issue.closedByPullRequestsReferences.nodes,
    ].filter((pr) => pr?.number && pr.repository?.nameWithOwner === upstream);
    if (attempted.has(issue.number) || pullRequests.some((pr) => pr.author?.login === me)) {
      excluded.attempted += 1;
      continue;
    }
    if (pullRequests.some((pr) => pr.state === "OPEN" || pr.state === "MERGED")) {
      excluded.pullRequest += 1;
      continue;
    }
    const labels = issue.labels.nodes.map((label) => label.name);
    result.push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      comments: issue.comments.totalCount,
      reactions: issue.reactions.totalCount,
      closedPullRequests: [...new Set(pullRequests.map((pr) => pr.number))],
      platformHints: [
        ...new Set(
          `${issue.title}\n${issue.bodyText}`
            .match(platformPattern)
            ?.map((hint) => hint.toLowerCase()) ?? [],
        ),
      ],
    });
  }
  result.sort(
    (left, right) =>
      Number(right.labels.includes("good first issue")) -
        Number(left.labels.includes("good first issue")) ||
      right.createdAt.localeCompare(left.createdAt),
  );
  print({ query: candidateQuery, searched: issues.length, excluded, candidates: result });
}

// Push over Git rather than `gh repo sync`: the API refuses upstream workflow changes without the
// token's `workflow` scope. A plain push only fast-forwards, so a diverged fork main fails here.
function sync() {
  git("fetch", "--quiet", "upstream", "main");
  git("push", "--quiet", "origin", "refs/remotes/upstream/main:refs/heads/main");
  const main = git("rev-parse", "refs/remotes/upstream/main");
  const forkMain = git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];
  if (forkMain !== main) throw new Error("The fork's main does not match upstream main.");
  print({ main });
}

function option(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function record() {
  const [issueText, event] = args;
  const issue = Number(issueText);
  if (!Number.isInteger(issue) || issue <= 0) throw new Error("record needs an issue number.");
  if (!recordableEvents.has(event)) {
    throw new Error(
      `record events are ${[...recordableEvents].join(", ")}; status records merges and closures.`,
    );
  }
  const branch = option("branch");
  const pr = option("pr") === undefined ? undefined : Number(option("pr"));
  const entry = { issue, event, branch, thread: option("thread"), pr, reason: option("reason") };
  if (event === "started") {
    if (!branch?.startsWith(branchPrefix))
      throw new Error(`started needs --branch ${branchPrefix}<issue>-<slug>.`);
    const other = attempts().find((attempt) => isActive(attempt) && attempt.issue !== issue);
    if (other) throw new Error(`Issue #${other.issue} is still active; finish it first.`);
  }
  if (event === "pr" && !Number.isInteger(pr)) throw new Error("pr needs --pr <number>.");
  if (event === "skipped" && !entry.reason) throw new Error("skipped needs --reason.");
  print(appendLog(entry));
}

function help() {
  console.log(`Usage: scripts/upstream-maint <command>

  status       Active attempt and its pull request; records merges and closures.
  candidates   Open accepted bugs without an open or merged PR, excluding attempted issues.
  sync         Fast-forward the fork's main to ${upstream} main.
  record <issue> started --branch ${branchPrefix}<issue>-<slug> [--thread <id>]
  record <issue> pr --pr <number>
  record <issue> skipped --reason <text>
  log          Every recorded attempt.

Attempts are kept in ${logPath}.`);
}

try {
  switch (command) {
    case "status":
      status();
      break;
    case "candidates":
      candidates();
      break;
    case "sync":
      sync();
      break;
    case "record":
      record();
      break;
    case "log":
      print(attempts());
      break;
    case "help":
      help();
      break;
    default:
      help();
      process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
