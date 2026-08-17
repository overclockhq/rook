"use strict";

const APP_VERSION = "112";
const POLL_MS = 2000;

// If the server is newer than this loaded bundle, break the browser cache by
// reloading with a fresh query (once per version, guarded against loops).
let versionNotified = false;
function checkVersion(st) {
  const sv = st.appVersion;
  if (!sv || sv === APP_VERSION) return;
  const key = "apReload_" + sv;
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, "1");
    location.replace(location.pathname + "?r=" + sv + location.hash);
  } else if (!versionNotified) {
    versionNotified = true;
    flash("Update available — hard-refresh to load v" + sv, true);
  }
}
let selectedId = null;
let lastState = null;
let lastOk = 0;

const $ = (id) => document.getElementById(id);

// ---- icon set (Lucide-style inline SVG; replaces emoji for a pro look) ----
const ICONS = {
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  hat: '<path d="M2 18h20"/><path d="M5 18v-2a7 7 0 0 1 14 0v2"/><path d="M12 6v-.5"/>',
  diff: '<line x1="12" y1="5" x2="12" y2="11"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="16" x2="15" y2="16"/><path d="M5 3h9l5 5v13a0 0 0 0 1 0 0H5z"/>',
};
function icon(name, cls) {
  return `<svg class="ico${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}

function fmtTokens(n) {
  if (n == null) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function ago(ms, now) {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

function countdown(oldestMs, now, windowMs) {
  // window resets when the oldest counted activity exits the window
  const resetIn = Math.max(0, oldestMs + windowMs - now);
  return resetIn;
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function shortModel(m) {
  if (!m) return "";
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    lastState = await res.json();
    lastOk = Date.now();
    render(lastState);
    $("connDot").classList.remove("stale");
    document.body.classList.remove("booting");
  } catch (e) {
    $("connDot").classList.add("stale");
  }
}

function isTyping() {
  const a = document.activeElement;
  return a && a.classList && a.classList.contains("reply");
}

// ---- tab navigation ----
let curPage = localStorage.getItem("apPage") || "home";
function showPage(p) {
  const pages = ["home", "board", "sessions", "term", "usage", "dev", "workspace", "audit", "github", "summaries", "logos"];
  p = (p || "").split("/")[0];
  if (!pages.includes(p)) p = "home";
  curPage = p;
  pages.forEach((x) => {
    $("page-" + x)?.classList.toggle("on", x === p);
  });
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("on", t.dataset.page === p)
  );
  // lock page scroll on the Terminal so its tab strip + toolbar stay fixed and
  // only the output scrolls
  document.body.classList.toggle("term-active", p === "term");
  // the onboarding banner belongs on Home only, not stamped on every page
  const nz = $("notices"); if (nz) nz.style.display = p === "home" ? "" : "none";
  if (p === "github") ghEnsure();
  if (p === "workspace") { renderWorktrees(); renderHooks(); }
  if (p === "board" && lastState) renderBoard(lastState.sessions, lastState.now);
  if (p === "usage") renderCostBreakdown();
  if (p === "summaries") { renderSummaries(); startSummaryPoll(); }
  else stopSummaryPoll();
  if (p === "term") startTermPoll();
  else stopTermPoll();
}

// keep the saved-summaries list fresh while viewing (the agent saves async)
let sumPollTimer = null;
function startSummaryPoll() { stopSummaryPoll(); sumPollTimer = setInterval(renderSummaries, 5000); }
function stopSummaryPoll() { clearInterval(sumPollTimer); sumPollTimer = null; }
function initLogos() {
  document.querySelectorAll(".logocard").forEach((c) =>
    c.addEventListener("click", () => {
      const svg = c.querySelector("svg").cloneNode(true);
      svg.setAttribute("class", "logo");
      svg.setAttribute("width", "30");
      svg.setAttribute("height", "30");
      const cur = document.querySelector(".brand .logo");
      if (cur) cur.replaceWith(svg);
      document.querySelectorAll(".logocard").forEach((x) => x.classList.toggle("sel", x === c));
      flash("previewing: " + c.querySelector(".lname").textContent);
    })
  );
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      localStorage.setItem("apPage", t.dataset.page);
      location.hash = t.dataset.page;
      showPage(t.dataset.page);
    })
  );
  const hash = location.hash.replace("#", "");
  showPage(hash || curPage);
  window.addEventListener("hashchange", () => showPage(location.hash.replace("#", "") || "home"));
}

// ---- GitHub (read-only via gh CLI) ----
const gh = { loaded: false, login: "", orgs: [], owner: "", repos: [], repo: "", sub: "issues", items: { issues: null, prs: null }, selected: new Set() };

// ---- batch hand-off queue: run N handoff agents at a time ----
let batchQueue = [], batchConcurrency = 2, batchCwd = "";
function startBatch(jobs, cwd, conc) {
  batchQueue.push(...jobs); batchConcurrency = conc; batchCwd = cwd;
  flash(`handing off ${jobs.length} agent${jobs.length > 1 ? "s" : ""} · ${conc} at a time`);
  pumpBatch();
}
function pumpBatch() {
  if (!batchQueue.length) return;
  const active = (((lastState && lastState.sessions) || []).filter((s) => s.alive && s.cwd && s.cwd.includes("/.rook/worktrees/"))).length;
  let slots = batchConcurrency - active;
  while (slots > 0 && batchQueue.length) {
    const job = batchQueue.shift();
    spawnAgent({ name: job.name, cwd: batchCwd, agent: "claude", prompt: job.prompt, worktree: true });
    slots--;
  }
}

function ghEnsure() {
  // honor a deep link like #github/owner/repo
  const parts = location.hash.replace("#", "").split("/");
  if (parts[0] === "github" && parts[1]) {
    gh.pendingOwner = parts[1];
    gh.pendingRepo = parts[2] ? parts[1] + "/" + parts[2] : "";
  }
  if (gh.loaded) return;
  gh.loaded = true;
  ghLoadOrgs();
}

function initGitHub() {
  $("ghRepoSearch")?.addEventListener("input", ghRenderRepos);
  document.querySelectorAll(".gh-sub").forEach((b) =>
    b.addEventListener("click", () => {
      gh.sub = b.dataset.sub;
      document.querySelectorAll(".gh-sub").forEach((x) => x.classList.toggle("on", x === b));
      ghRenderItems();
    })
  );
}

async function ghGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await apiErr(res)) || res.status);
  return res.json();
}

async function ghLoadOrgs() {
  const el = $("ghOrgs");
  el.innerHTML = `<span class="muted">loading…</span>`;
  try {
    const d = await ghGet("/api/github/orgs");
    gh.login = d.login;
    gh.orgs = d.orgs || [];
    ghRenderOrgs();
    ghSelectOwner(gh.pendingOwner || gh.login);
  } catch (e) {
    el.innerHTML = `<span class="gherr">gh error: ${esc(String(e).slice(0, 120))}</span>`;
  }
}

function ghRenderOrgs() {
  const owners = [gh.login, ...gh.orgs];
  $("ghOrgs").innerHTML = owners
    .map(
      (o) => `<button class="gh-org${o === gh.owner ? " on" : ""}" data-owner="${esc(o)}">${esc(o)}${o === gh.login ? " (you)" : ""}</button>`
    )
    .join("");
  $("ghOrgs").querySelectorAll(".gh-org").forEach((b) =>
    b.addEventListener("click", () => ghSelectOwner(b.dataset.owner))
  );
}

async function ghSelectOwner(owner) {
  gh.owner = owner;
  gh.repo = "";
  gh.items = { issues: null, prs: null };
  ghRenderOrgs();
  $("ghItems").innerHTML = `<p class="empty">Select a repository.</p>`;
  $("ghRepoTitle").textContent = "Issues & PRs";
  const list = $("ghRepoList");
  list.innerHTML = `<li class="empty">loading repos…</li>`;
  try {
    gh.repos = await ghGet("/api/github/repos?owner=" + encodeURIComponent(owner));
    gh.repos.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    ghRenderRepos();
    if (gh.pendingRepo) {
      const target = gh.pendingRepo;
      gh.pendingRepo = "";
      if (gh.repos.some((r) => r.nameWithOwner === target)) ghSelectRepo(target);
    }
  } catch (e) {
    list.innerHTML = `<li class="gherr">${esc(String(e).slice(0, 140))}</li>`;
  }
}

function ghRenderRepos() {
  const q = ($("ghRepoSearch")?.value || "").toLowerCase().trim();
  const list = (gh.repos || []).filter(
    (r) => !q || (r.name + " " + (r.description || "")).toLowerCase().includes(q)
  );
  $("ghRepoCount").textContent = `${list.length}`;
  const el = $("ghRepoList");
  if (list.length === 0) { el.innerHTML = `<li class="empty">no repos</li>`; return; }
  el.innerHTML = list
    .map(
      (r) => `<li class="ghrepo${r.nameWithOwner === gh.repo ? " sel" : ""}" data-repo="${esc(r.nameWithOwner)}">
        <div class="ghrepo-top">
          <div class="ghrepo-name">${esc(r.name)}
            ${r.isPrivate ? '<span class="ghtag">private</span>' : ""}
            ${r.isArchived ? '<span class="ghtag arc">archived</span>' : ""}</div>
          <button class="btn ghclone" data-clone="${esc(r.nameWithOwner)}" title="Clone this repo locally">${icon("plus")} Clone</button>
        </div>
        <div class="ghrepo-desc muted">${esc(r.description || "—")}</div>
        <div class="ghrepo-meta muted">${esc((r.primaryLanguage && r.primaryLanguage.name) || "")}${r.stargazerCount ? " · ★ " + r.stargazerCount : ""} · ${ago(Date.parse(r.updatedAt), Date.now())}</div>
      </li>`
    )
    .join("");
  el.querySelectorAll(".ghrepo").forEach((li) =>
    li.addEventListener("click", () => ghSelectRepo(li.dataset.repo))
  );
  el.querySelectorAll("[data-clone]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); cloneRepoFromGitHub(b.dataset.clone); })
  );
}

// cloneRepoFromGitHub clones a repo into a parent dir (remembered / prompted) and
// stores its local path so future handoffs auto-fill it.
async function cloneRepoFromGitHub(repo) {
  let parent = guessParentDir();
  parent = prompt(`Clone ${repo} into which parent directory?`, parent || "");
  if (!parent) return;
  flash(`cloning ${repo}…`);
  try {
    const res = await fetch("/api/clone", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, dir: parent.trim() }),
    });
    if (!res.ok) { flash(await apiErr(res), true); return; }
    const d = await res.json();
    setRepoPath(repo.split("/").pop(), d.path);
    flash(d.reused ? `already cloned at ${d.path}` : `cloned to ${d.path}`);
  } catch (e) { flash("clone failed", true); }
}

async function ghSelectRepo(repo) {
  gh.repo = repo;
  gh.items = { issues: null, prs: null };
  gh.selected.clear();
  ghRenderRepos();
  $("ghRepoTitle").textContent = repo;
  const el = $("ghItems");
  el.innerHTML = `<p class="empty">loading…</p>`;
  try {
    const [issues, prs] = await Promise.all([
      ghGet("/api/github/issues?repo=" + encodeURIComponent(repo)),
      ghGet("/api/github/prs?repo=" + encodeURIComponent(repo)),
    ]);
    gh.items = { issues, prs };
    ghRenderItems();
  } catch (e) {
    el.innerHTML = `<p class="gherr">${esc(String(e).slice(0, 160))}</p>`;
  }
}

function ghRenderItems() {
  const el = $("ghItems");
  if (!gh.repo) { el.innerHTML = `<p class="empty">Select a repository.</p>`; return; }
  const data = gh.items[gh.sub];
  if (data === null) { el.innerHTML = `<p class="empty">loading…</p>`; return; }
  document.querySelectorAll(".gh-sub").forEach((b) => {
    const c = gh.items[b.dataset.sub];
    b.textContent = (b.dataset.sub === "prs" ? "PRs" : "Issues") + (c ? ` (${c.length})` : "");
  });
  if (!data.length) { el.innerHTML = `<p class="empty">No open ${gh.sub}.</p>`; return; }
  el.innerHTML = ghBatchBar() + data.map((it, i) => ghItemRow(it, gh.sub, i)).join("");
  el.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => window.open(b.dataset.open, "_blank"))
  );
  el.querySelectorAll("[data-work]").forEach((b) =>
    b.addEventListener("click", () => handToAgent(data[parseInt(b.dataset.work, 10)], gh.sub, b.dataset.mode || "work"))
  );
  el.querySelectorAll(".gh-cb").forEach((cb) =>
    cb.addEventListener("change", () => {
      const n = parseInt(cb.dataset.num, 10);
      if (cb.checked) gh.selected.add(n); else gh.selected.delete(n);
      ghRenderItems();
    })
  );
  $("ghBatchGo")?.addEventListener("click", ghHandOffSelected);
  $("ghBatchClear")?.addEventListener("click", () => { gh.selected.clear(); ghRenderItems(); });
  el.querySelectorAll("[data-jump]").forEach((b) =>
    b.addEventListener("click", () => {
      selectedId = b.dataset.jump;
      showPage("sessions"); location.hash = "sessions";
      if (lastState) { renderSessions(lastState.sessions, lastState.now); renderDetail(lastState.sessions, lastState.now); }
      document.querySelector(".grid")?.scrollIntoView({ behavior: "smooth" });
    })
  );
}

// buildWorkPrompt turns a GitHub issue/PR into a spawn name + initial prompt.
// mode: "work" (implement) or "review" (review a PR).
function buildWorkPrompt(it, kind, mode) {
  const num = it.number;
  const repoShort = (gh.repo || "").split("/").pop();
  let prompt, name;
  if (mode === "review") {
    name = `review-pr-${num}`;
    prompt =
      `Review GitHub pull request #${num} in ${gh.repo}: "${it.title}".\n${it.url}\n\n` +
      `Check out the PR branch (gh pr checkout ${num}), read the diff, and review it for correctness, ` +
      `bugs, security, tests, and style. Summarize findings with file:line references and concrete suggestions. ` +
      `Do not push changes unless asked.`;
  } else if (kind === "prs") {
    name = `pr-${num}`;
    prompt =
      `Continue work on GitHub pull request #${num} in ${gh.repo}: "${it.title}".\n${it.url}\n\n` +
      `Check out the PR branch (gh pr checkout ${num}), address review comments and failing checks, ` +
      `run tests, and push the fixes.`;
  } else {
    name = `issue-${num}`;
    prompt =
      `Work on GitHub issue #${num} in ${gh.repo}: "${it.title}".\n${it.url}\n\n` +
      `Read the issue, implement the change on a new branch off the default branch, run tests, and open a PR when done.`;
  }
  return { name, prompt, repoShort, num };
}

// handToAgent is the wired work loop: from a GitHub issue/PR, spawn an agent in
// the matching local repo and drop straight into its live terminal. Falls back
// to prefilling the Spawn form when the local repo path can't be resolved.
async function handToAgent(it, kind, mode) {
  if (!it) return;
  const { name, prompt, repoShort, num } = buildWorkPrompt(it, kind, mode);
  if (lastState && lastState.tmuxAvailable === false) {
    workOnItem(it, kind, mode);
    flash("tmux needed to spawn — prompt prefilled instead", true);
    return;
  }
  const cwd = guessRepoPath(repoShort);
  if (!cwd) {
    // no local checkout found — prefill so the user can set the path, then Spawn
    workOnItem(it, kind, mode);
    return;
  }
  setRepoPath(repoShort, cwd); // remember for next time
  flash(`handing #${num} to an agent (isolated worktree)…`);
  // worktree:true → the agent gets its own git worktree; the user's branch/checkout is untouched
  const ok = await spawnAgent({ name, cwd, agent: "claude", prompt, worktree: true });
  if (!ok) return;
  flash(`agent on #${num} — isolated worktree, dropping into its terminal`);
  openTerm("", name, `${name} · #${num}`); // live pane of the new tmux session (control is by target)
  setTimeout(poll, 700);
}

// ---- cross-links: session <-> GitHub issue/PR ----
const GH_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i;

// githubRefFromSession extracts the issue/PR a session is working on, read from
// the initial prompt / summary (rook writes the GitHub URL into the spawn prompt).
function githubRefFromSession(s) {
  const hay = `${s.lastPrompt || ""} ${s.summary || ""} ${s.title || ""}`;
  const m = hay.match(GH_URL_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], kind: m[3] === "pull" ? "pr" : "issue", number: parseInt(m[4], 10), url: m[0] };
}

// sessionForItem finds a live session already working on a given GitHub item.
function sessionForItem(it) {
  if (!lastState || !it) return null;
  const repoShort = (gh.repo || "").split("/").pop();
  return (lastState.sessions || []).find((s) => {
    const r = githubRefFromSession(s);
    return r && r.number === it.number && r.repo === repoShort;
  });
}

// pendingWorkRepo(Full) remember which repo the prefilled Spawn form is for, so
// the path is saved to memory on Spawn and Clone targets the right repo.
let pendingWorkRepo = null, pendingWorkRepoFull = null;

// guessParentDir picks a sensible default parent for cloning (where the user
// already keeps clones), from remembered repo paths or open session dirs.
function guessParentDir() {
  const paths = [...Object.values(repoPathMap()), ...(((lastState && lastState.sessions) || []).map((s) => s.cwd).filter(Boolean))];
  for (const p of paths) { const i = p.lastIndexOf("/"); if (i > 0) return p.slice(0, i); }
  return "";
}

// workOnItem pre-fills the Spawn form (fallback when we can't auto-spawn):
// pick an existing clone, or clone the repo into a path.
function workOnItem(it, kind, mode) {
  if (!it) return;
  const { name, prompt, repoShort, num } = buildWorkPrompt(it, kind, mode);
  const known = guessRepoPath(repoShort);
  openLaunch({
    name, prompt, repoShort, repoFull: gh.repo,
    cwd: known || "",
    showClone: !known,
    worktree: true,
  });
  flash(
    known
      ? `${mode === "review" ? "Review" : "Work"} prompt ready for #${num} — repo found, just Launch`
      : `${mode === "review" ? "Review" : "Work"} prompt ready for #${num} — pick your ${repoShort} clone or clone it, then Launch`
  );
}

// repo → local clone path memory (so you set a repo's path only once)
function repoPathMap() { try { return JSON.parse(localStorage.getItem("apRepoPaths") || "{}"); } catch (e) { return {}; } }
function setRepoPath(name, cwd) {
  if (!name || !cwd) return;
  const m = repoPathMap(); m[name] = cwd; localStorage.setItem("apRepoPaths", JSON.stringify(m));
}

// guessRepoPath resolves a repo's local clone path: first from remembered paths,
// then by matching an open session's cwd basename.
function guessRepoPath(name) {
  if (!name) return "";
  const remembered = repoPathMap()[name];
  if (remembered) return remembered;
  const hit = (lastState && lastState.sessions || []).find(
    (s) => s.cwd && s.cwd.split("/").pop() === name
  );
  return hit ? hit.cwd : "";
}

function ghCIStatus(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "";
  let fail = 0, pend = 0, ok = 0;
  rollup.forEach((c) => {
    const s = (c.conclusion || c.state || c.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s)) fail++;
    else if (["SUCCESS", "NEUTRAL", "COMPLETED"].includes(s)) ok++;
    else pend++;
  });
  if (fail) return `<span class="ghci fail" title="${fail} failing">✗ checks</span>`;
  if (pend) return `<span class="ghci pend" title="${pend} pending">● checks</span>`;
  if (ok) return `<span class="ghci ok" title="all passing">✓ checks</span>`;
  return "";
}

// ghBatchBar renders the multi-select hand-off bar when items are selected.
function ghBatchBar() {
  const n = gh.selected.size;
  if (!n) return "";
  return `<div class="gh-batch">
    <span class="bulk-n">${n} selected</span>
    <label class="muted" style="font-size:12px;display:flex;align-items:center;gap:5px">run <input id="ghBatchConc" class="sf-search cap" type="number" min="1" max="8" value="${batchConcurrency}" style="width:52px" /> at a time</label>
    <button id="ghBatchGo" class="btn allow">Hand off ${n} ${gh.sub === "prs" ? "PRs" : "issues"}</button>
    <button id="ghBatchClear" class="btn ghost">Clear</button>
  </div>`;
}

// ghHandOffSelected queues the selected items as isolated-worktree agents.
function ghHandOffSelected() {
  const nums = [...gh.selected];
  if (!nums.length) return;
  const repoShort = (gh.repo || "").split("/").pop();
  const cwd = guessRepoPath(repoShort);
  if (!cwd) { flash(`clone/select ${repoShort} locally first (Clone button on the repo)`, true); return; }
  const conc = Math.max(1, Math.min(8, parseInt($("ghBatchConc")?.value || "2", 10) || 2));
  const data = gh.items[gh.sub] || [];
  const jobs = nums.map((n) => {
    const it = data.find((x) => x.number === n);
    if (!it) return null;
    const { name, prompt } = buildWorkPrompt(it, gh.sub, gh.sub === "prs" ? "review" : "work");
    return { name: (name + "-" + (Date.now() % 10000) + n).slice(0, 40), prompt };
  }).filter(Boolean);
  startBatch(jobs, cwd, conc);
  gh.selected.clear();
  ghRenderItems();
}

function ghItemRow(it, kind, idx) {
  const labels = (it.labels || [])
    .slice(0, 5)
    .map((l) => `<span class="ghlabel"${l.color ? ` style="border-color:#${esc(l.color)}"` : ""}>${esc(l.name)}</span>`)
    .join("");
  const assignees = (it.assignees || []).map((a) => a.login).filter(Boolean);
  const assignHTML = assignees.length
    ? `<span class="ghassign" title="assignees">👤 ${assignees.slice(0, 3).map(esc).join(", ")}${assignees.length > 3 ? " +" + (assignees.length - 3) : ""}</span>`
    : `<span class="ghassign none">unassigned</span>`;
  const author = (it.author && it.author.login) || "?";

  let status = "";
  if (kind === "prs") {
    if (it.isDraft) status += `<span class="ghtag">draft</span>`;
    const rd = it.reviewDecision;
    if (rd) {
      const cls = rd === "APPROVED" ? "ok" : rd === "CHANGES_REQUESTED" ? "bad" : "";
      status += `<span class="ghtag ${cls}">${esc(rd.toLowerCase().replace(/_/g, " "))}</span>`;
    } else status += `<span class="ghtag">no review</span>`;
    status += ghCIStatus(it.statusCheckRollup);
    status += `<span class="ghdiff">+${it.additions || 0} −${it.deletions || 0}</span>`;
  } else {
    if ((it.comments || 0) > 0) status += `<span class="ghtag">💬 ${it.comments}</span>`;
  }
  const working = sessionForItem(it);
  const workingTag = working
    ? `<span class="ghtag ok" data-jump="${working.sessionId}" title="an agent is working on this — jump to it" style="cursor:pointer"><span class="sdot s-${statusOf(working)}" style="display:inline-block;vertical-align:middle;margin-right:4px"></span>agent working</span>`
    : "";
  const tags = workingTag + status + labels;

  return `<div class="ghitem${working ? " has-agent" : ""}">
    <input type="checkbox" class="gh-cb" data-num="${it.number}" title="select for batch hand-off"${gh.selected.has(it.number) ? " checked" : ""} />
    <div class="ghitem-main">
      <div class="ghitem-title"><span class="ghnum">#${it.number}</span> ${esc(it.title)}</div>
      <div class="ghitem-meta muted">by ${esc(author)} · ${ago(Date.parse(it.updatedAt), Date.now())} · ${assignHTML}</div>
      ${tags ? `<div class="ghitem-tags">${tags}</div>` : ""}
    </div>
    <div class="ghitem-btns">
      ${working
        ? `<button class="btn" data-jump="${working.sessionId}" title="Jump to the agent working this">${icon("terminal")} View agent</button>`
        : kind === "prs"
        ? `<button class="btn ghworkbtn" data-work="${idx}" data-mode="review" title="Spawn an agent to review this PR">${icon("search")} Review</button>
           <button class="btn" data-work="${idx}" data-mode="work" title="Hand this PR to an agent">${icon("play")} Hand off</button>`
        : `<button class="btn ghworkbtn" data-work="${idx}" data-mode="work" title="Spawn an agent on this issue and drop into its terminal">${icon("play")} Hand to agent</button>`}
      <button class="ghopen" data-open="${esc(it.url)}" title="Open on GitHub">${icon("external")}</button>
    </div>
  </div>`;
}

// ---- orchestration: spawn agents ----
const SPAWN_PRESETS = {
  review: "Review the current branch / open PR for correctness, bugs, security, missing tests, and style. Summarize findings with file:line references and concrete suggestions. Do not push changes unless asked.",
  fix: "Read the assigned issue/task, implement the change on a new branch off the default branch, run the tests, and open a PR when done.",
  tests: "Add and expand tests for the recently changed code to raise coverage. Run the full test suite and report what you added and any failures.",
  deps: "Update dependencies to their latest compatible versions, run the build and tests, fix any breakage, and open a PR describing the upgrades.",
};
function initSpawn() {
  const form = $("spawnForm");
  $("spawnBtn")?.addEventListener("click", () => openLaunch());
  $("spCancel")?.addEventListener("click", () => { form.hidden = true; if ($("spClone")) $("spClone").hidden = true; });
  $("spPreset")?.addEventListener("change", (e) => {
    const t = SPAWN_PRESETS[e.target.value];
    if (t) $("spPrompt").value = t;
  });
  $("spCloneGo")?.addEventListener("click", async () => {
    const dir = $("spCloneDir").value.trim();
    if (!dir) { flash("enter a parent directory to clone into", true); return; }
    if (!pendingWorkRepoFull) { flash("no repo selected", true); return; }
    const btn = $("spCloneGo");
    btn.disabled = true; btn.textContent = "Cloning…";
    try {
      const res = await fetch("/api/clone", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: pendingWorkRepoFull, dir }),
      });
      if (!res.ok) { flash(await apiErr(res), true); return; }
      const d = await res.json();
      $("spCwd").value = d.path;
      if (pendingWorkRepo) setRepoPath(pendingWorkRepo, d.path);
      $("spClone").hidden = true;
      flash(d.reused ? "found existing clone — click Spawn" : "cloned — click Spawn");
    } catch (e) { flash("clone failed", true); }
    finally { btn.disabled = false; btn.textContent = "Clone"; }
  });
  $("spGo")?.addEventListener("click", async () => {
    const body = {
      name: $("spName").value.trim(),
      cwd: $("spCwd").value.trim(),
      agent: $("spAgent").value,
      prompt: $("spPrompt").value,
    };
    if (!body.name || !body.cwd) { flash("name and directory required", true); return; }
    if (await spawnAgent(body)) {
      // remember this repo's local path so future handoffs auto-fill it
      if (pendingWorkRepo) { setRepoPath(pendingWorkRepo, body.cwd); pendingWorkRepo = null; }
      flash(`spawned ${body.agent} · ${body.name}`);
      form.hidden = true;
      $("spName").value = ""; $("spPrompt").value = "";
      setTimeout(poll, 600);
    }
  });
}

// spawnAgent POSTs to /api/spawn and returns whether it succeeded.
async function spawnAgent(body) {
  try {
    const res = await fetch("/api/spawn", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) { flash(await apiErr(res), true); return false; }
    return true;
  } catch (e) { flash("spawn failed", true); return false; }
}

// ---- Launch modal: repo-first, worktree-by-default session launcher ----
let lgRepos = [];        // discovered repos [{path,name,branch}]
let lgRepo = null;       // chosen repo {path,name,branch}, or null (typed path)
let lgNameDirty = false; // user hand-edited the name → stop auto-deriving from task

// slugifyTask turns a task sentence into a short branch-ish session name.
function slugifyTask(s) {
  const base = (s || "").toLowerCase().replace(/[`'"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!base) return "";
  return base.split("-").filter(Boolean).slice(0, 5).join("-").slice(0, 40).replace(/-+$/, "");
}

// openLaunch shows the launcher. opts may prefill {prompt,name,cwd,worktree,repoFull,repoShort,showClone}.
async function openLaunch(opts = {}) {
  lgNameDirty = !!opts.name; lgRepo = null;
  pendingWorkRepoFull = opts.repoFull || null;
  pendingWorkRepo = opts.repoShort || null;
  $("lgPrompt").value = opts.prompt || "";
  $("lgName").value = opts.name || "";
  $("lgAgent").value = "claude";
  $("lgWorktree").checked = opts.worktree !== false;
  $("lgRepoSearch").value = "";
  $("lgClone").hidden = !opts.showClone;
  if (opts.showClone) { $("lgCloneRepo").textContent = opts.repoFull || ""; if (!$("lgCloneDir").value) $("lgCloneDir").value = guessParentDir(); }
  openModal("launch");
  renderLgRepoList("");
  await loadLgRepos();
  if (opts.cwd) selectLgRepo({ path: opts.cwd, name: opts.cwd.split("/").filter(Boolean).pop() || opts.cwd, branch: "" });
  setTimeout(() => ((opts.cwd ? $("lgPrompt") : $("lgRepoSearch")) || {}).focus?.(), 40);
}

async function loadLgRepos() {
  try { const res = await fetch("/api/repos", { cache: "no-store" }); lgRepos = res.ok ? await res.json() : []; }
  catch (e) { lgRepos = []; }
  renderLgRepoList($("lgRepoSearch").value.trim());
}

function renderLgRepoList(q) {
  const el = $("lgRepoList");
  if (!el) return;
  const ql = (q || "").toLowerCase();
  const isPath = q && q.startsWith("/");
  const matches = lgRepos.filter((r) => !ql || r.name.toLowerCase().includes(ql) || r.path.toLowerCase().includes(ql));
  let html = "";
  if (isPath && !matches.some((r) => r.path === q)) {
    html += `<div class="lg-repo-item" data-path="${esc(q)}"><span class="lg-repo-name">Use this path</span><span class="lg-repo-path muted">${esc(q)}</span></div>`;
  }
  html += matches.slice(0, 40).map((r) => `
    <div class="lg-repo-item${lgRepo && lgRepo.path === r.path ? " sel" : ""}" data-path="${esc(r.path)}">
      <span class="lg-repo-name">${esc(r.name)}</span>
      ${r.branch ? `<span class="lg-repo-branch">${esc(r.branch)}</span>` : ""}
      <span class="lg-repo-path muted">${esc(r.path)}</span>
    </div>`).join("");
  if (!html) html = `<div class="lg-repo-empty muted">No repos match — paste an absolute path (starts with /).</div>`;
  el.innerHTML = html;
  el.querySelectorAll(".lg-repo-item").forEach((it) =>
    it.addEventListener("click", () => {
      const p = it.dataset.path;
      const r = lgRepos.find((x) => x.path === p) || { path: p, name: p.split("/").filter(Boolean).pop() || p, branch: "" };
      selectLgRepo(r);
    }));
}

function selectLgRepo(r) {
  lgRepo = r;
  $("lgRepoSearch").value = r.name + (r.branch ? "  ·  " + r.branch : "");
  renderLgRepoList("");
  maybeAutoName();
}

// maybeAutoName keeps the session name in sync with the task until the user edits it.
function maybeAutoName() {
  if (lgNameDirty) return;
  $("lgName").value = slugifyTask($("lgPrompt").value) || (lgRepo ? slugifyTask(lgRepo.name) : "");
}

function initLaunch() {
  $("lgClose")?.addEventListener("click", () => closeModal("launch"));
  $("lgCancel")?.addEventListener("click", () => closeModal("launch"));
  $("lgRepoSearch")?.addEventListener("input", (e) => { lgRepo = null; renderLgRepoList(e.target.value.trim()); });
  $("lgPrompt")?.addEventListener("input", maybeAutoName);
  $("lgName")?.addEventListener("input", () => { lgNameDirty = true; });
  document.querySelectorAll(".lg-chip").forEach((c) =>
    c.addEventListener("click", () => {
      const t = SPAWN_PRESETS[c.dataset.preset];
      if (t) { $("lgPrompt").value = t; maybeAutoName(); $("lgPrompt").focus(); }
    }));
  $("lgCloneGo")?.addEventListener("click", lgCloneRepo);
  $("lgGo")?.addEventListener("click", launchFromModal);
}

async function lgCloneRepo() {
  const dir = $("lgCloneDir").value.trim();
  if (!dir) { flash("enter a parent directory to clone into", true); return; }
  if (!pendingWorkRepoFull) { flash("no repo selected", true); return; }
  const btn = $("lgCloneGo"); btn.disabled = true; btn.textContent = "Cloning…";
  try {
    const res = await fetch("/api/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: pendingWorkRepoFull, dir }) });
    if (!res.ok) { flash(await apiErr(res), true); return; }
    const d = await res.json();
    selectLgRepo({ path: d.path, name: d.path.split("/").filter(Boolean).pop() || d.path, branch: "" });
    if (pendingWorkRepo) setRepoPath(pendingWorkRepo, d.path);
    $("lgClone").hidden = true;
    flash(d.reused ? "found existing clone" : "cloned");
  } catch (e) { flash("clone failed", true); }
  finally { btn.disabled = false; btn.textContent = "Clone"; }
}

async function launchFromModal() {
  const typed = $("lgRepoSearch").value.trim();
  const cwd = lgRepo ? lgRepo.path : (typed.startsWith("/") ? typed : "");
  if (!cwd) { flash("pick a repository (or paste an absolute path)", true); $("lgRepoSearch").focus(); return; }
  const name = $("lgName").value.trim() || slugifyTask($("lgPrompt").value) || "session";
  const body = { name, cwd, agent: $("lgAgent").value, prompt: $("lgPrompt").value, worktree: $("lgWorktree").checked };
  const btn = $("lgGo"); btn.disabled = true; btn.textContent = "Launching…";
  const ok = await spawnAgent(body);
  btn.disabled = false; btn.textContent = "Launch ▶";
  if (!ok) return;
  if (pendingWorkRepo) { setRepoPath(pendingWorkRepo, cwd); pendingWorkRepo = null; }
  closeModal("launch");
  flash(`launched ${body.agent} · ${name}`);
  openTerm("", name, name); // drop straight into the live terminal
  setTimeout(poll, 600);
}

// ---- Claude Code hooks bridge: install/status/gate + live events feed ----
function initHooks() {
  $("hkInstall")?.addEventListener("click", () => hooksAction("/api/hooks/install", "hooks installed"));
  $("hkRemove")?.addEventListener("click", () => hooksAction("/api/hooks/uninstall", "hooks removed"));
  const saveToggle = (key, on, msg) =>
    fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: on }) })
      .then(() => flash(msg)).catch(() => flash("couldn't save", true));
  $("hkGate")?.addEventListener("change", (e) => saveToggle("hooksGate", e.target.checked, e.target.checked ? "destructive-command gate on" : "gate off"));
  $("hkAutoReview")?.addEventListener("change", (e) => saveToggle("autoReview", e.target.checked, e.target.checked ? "auto-review on" : "auto-review off"));
  $("hkAutoVerify")?.addEventListener("change", (e) => saveToggle("autoVerify", e.target.checked, e.target.checked ? "auto-run tests on" : "auto-run tests off"));
}
async function hooksAction(url, ok) {
  try {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok) { flash(await apiErr(res), true); return; }
    flash(ok); renderHooks();
  } catch (e) { flash("action failed", true); }
}
async function renderHooks() {
  const st = $("hkStatus"); if (!st) return;
  try {
    const s = await (await fetch("/api/hooks/status", { cache: "no-store" })).json();
    st.textContent = s.installed ? "installed" : "not installed";
    st.className = "muted " + (s.installed ? "hk-on" : "");
    $("hkInstall").hidden = s.installed;
    $("hkRemove").hidden = !s.installed;
    $("hkGate").checked = !!s.gate;
    try {
      const cfg = await (await fetch("/api/config", { cache: "no-store" })).json();
      $("hkAutoReview").checked = !!cfg.autoReview;
      $("hkAutoVerify").checked = !!cfg.autoVerify;
    } catch (e) {}
    const evs = await (await fetch("/api/hooks/events", { cache: "no-store" })).json();
    const el = $("hkEvents");
    if (!evs.length) { el.innerHTML = `<p class="empty">No hook events yet${s.installed ? " — run a Claude Code session to see them" : ""}.</p>`; return; }
    el.innerHTML = evs.slice(0, 60).map((e) => `
      <div class="hk-ev">
        <span class="hk-evt hk-evt-${esc(e.event)}">${esc(e.event)}${e.tool ? " · " + esc(e.tool) : ""}</span>
        ${e.gated ? `<span class="hchip h-alert">blocked</span>` : ""}
        <span class="hk-evd muted mono">${esc(e.detail || "")}</span>
        <span class="hk-evtime muted">${e.project ? esc(e.project) + " · " : ""}${ago(e.time, Date.now())}</span>
      </div>`).join("");
  } catch (e) { st.textContent = "unavailable"; }
}

// ---- diff-first review: show an agent's git changes for a worktree/repo ----
let diffPath = null; // path of the currently-open diff
function initDiff() {
  $("diffClose")?.addEventListener("click", () => closeModal("diff"));
  $("diffReview")?.addEventListener("click", async () => {
    if (!diffPath) return;
    const b = $("diffReview"); b.disabled = true; b.textContent = "Spawning…";
    try {
      const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: diffPath }) });
      if (!res.ok) { flash(await apiErr(res), true); return; }
      const d = await res.json();
      closeModal("diff");
      flash(`review agent spawned · ${d.session}`);
      openTerm("", d.session, d.session);
      setTimeout(poll, 600);
    } catch (e) { flash("review failed", true); }
    finally { b.disabled = false; b.textContent = "Review with agent"; }
  });
  $("diffVerify")?.addEventListener("click", async () => {
    if (!diffPath) return;
    const b = $("diffVerify"); b.disabled = true; b.textContent = "Running…";
    try {
      const res = await fetch("/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: diffPath }) });
      if (!res.ok) { flash(await apiErr(res), true); return; }
      const d = await res.json();
      if (!d.ran) flash(d.output || "no test command detected", true);
      else flash(d.ok ? "✓ tests passed" : "✗ tests failed — see terminal output", !d.ok);
    } catch (e) { flash("verify failed", true); }
    finally { b.disabled = false; b.textContent = "Run tests"; }
  });
  $("diffEditor")?.addEventListener("click", async () => {
    if (!diffPath) return;
    try {
      const res = await fetch("/api/open-editor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: diffPath }) });
      flash(res.ok ? "opening in editor…" : await apiErr(res), !res.ok);
    } catch (e) { flash("couldn't open editor", true); }
  });
  $("diffPR")?.addEventListener("click", async () => {
    if (!diffPath) return;
    const title = prompt("PR title (blank = auto-fill from commits):", "");
    if (title === null) return;
    const b = $("diffPR"); b.disabled = true; b.textContent = "Opening…";
    try {
      const res = await fetch("/api/pr/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: diffPath, title: title.trim() }) });
      if (!res.ok) { flash(await apiErr(res), true); return; }
      const d = await res.json();
      flash("PR opened");
      if (d.url) window.open(d.url, "_blank");
    } catch (e) { flash("PR failed", true); }
    finally { b.disabled = false; b.textContent = "Open PR"; }
  });
}

let diffTarget = null; // tmux pane of the session, so inline comments can be sent to the agent
async function openDiff(path, title, target) {
  if (!path) { flash("no working directory for this session", true); return; }
  diffPath = path;
  diffTarget = target || null;
  openModal("diff");
  $("diffTitle").textContent = title || "changes";
  $("diffMeta").textContent = "";
  $("diffFiles").innerHTML = "";
  $("diffBody").innerHTML = `<p class="empty">loading diff…</p>`;
  try {
    const res = await fetch("/api/diff?path=" + encodeURIComponent(path), { cache: "no-store" });
    if (!res.ok) { $("diffBody").innerHTML = `<p class="gherr">${esc(await apiErr(res))}</p>`; return; }
    const data = await res.json();
    if (window.renderDiffV2) {
      $("diffFiles").style.display = "none"; $("diffMeta").textContent = "";
      renderDiffV2($("diffBody"), data, {
        onSend: (comments) => {
          if (!comments.length) return;
          const body = comments.map((c) => `- ${c.file}:${c.line} (${c.side}) — ${c.text}`).join("\n");
          const msg = `Please address these code review comments:\n${body}`;
          if (!diffTarget) { navigator.clipboard?.writeText(msg); flash("no live agent — comments copied to clipboard", true); return; }
          fetch("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: diffTarget, action: "text", value: msg }) })
            .then((r) => flash(r.ok ? `sent ${comments.length} comment(s) to the agent` : "send failed", !r.ok))
            .catch(() => flash("send failed", true));
        },
      });
    } else { renderDiff(data); }
  } catch (e) { $("diffBody").innerHTML = `<p class="gherr">couldn't load diff</p>`; }
}

function renderDiff(d) {
  const files = d.files || [];
  const baseShort = (d.base || "").length > 12 ? d.base.slice(0, 12) : d.base;
  $("diffMeta").innerHTML = files.length
    ? `${files.length} file${files.length === 1 ? "" : "s"} · <span class="d-add">+${d.add || 0}</span> <span class="d-del">−${d.del || 0}</span> · <span class="muted mono" title="diffed against">${esc(baseShort || "HEAD")}</span>${d.truncated ? ' · <span class="muted">(truncated)</span>' : ""}`
    : "";
  if (!files.length) {
    $("diffFiles").innerHTML = "";
    $("diffBody").innerHTML = `<p class="empty">No changes yet — this agent hasn't modified anything vs its base.</p>`;
    return;
  }
  const stChar = { M: "M", A: "A", D: "D", R: "R", "?": "+" };
  $("diffFiles").innerHTML = files.map((f, i) => `
    <button class="d-file" data-i="${i}" title="${esc(f.path)}">
      <span class="d-st d-st-${f.status === "?" ? "new" : f.status.toLowerCase()}">${stChar[f.status] || f.status}</span>
      <span class="d-fname">${esc(f.path)}</span>
      <span class="d-counts"><span class="d-add">+${f.add > 0 ? f.add : 0}</span> <span class="d-del">−${f.del > 0 ? f.del : 0}</span></span>
    </button>`).join("");
  $("diffBody").innerHTML = colorizePatch(d.patch || "");
  // click a file to jump to its hunk in the patch
  $("diffFiles").querySelectorAll(".d-file").forEach((b) =>
    b.addEventListener("click", () => {
      const p = files[+b.dataset.i].path;
      const anchor = [...$("diffBody").querySelectorAll(".dl-file")].find((el) => el.dataset.path === p);
      if (anchor) anchor.scrollIntoView({ behavior: "smooth", block: "start" });
      $("diffFiles").querySelectorAll(".d-file").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    }));
}

// colorizePatch renders a unified diff as safe, colored HTML lines.
function colorizePatch(patch) {
  if (!patch.trim()) return `<p class="empty">(no textual diff)</p>`;
  const out = [];
  for (const raw of patch.split("\n")) {
    const line = esc(raw);
    let cls = "dl", attr = "";
    if (raw.startsWith("diff --git")) {
      cls = "dl dl-file";
      // path after " b/"
      const m = raw.match(/ b\/(.+)$/);
      if (m) attr = ` data-path="${esc(m[1])}"`;
    } else if (raw.startsWith("@@")) cls = "dl dl-hunk";
    else if (/^(index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode)/.test(raw)) cls = "dl dl-meta";
    else if (raw.startsWith("+")) cls = "dl dl-add";
    else if (raw.startsWith("-")) cls = "dl dl-del";
    out.push(`<div class="${cls}"${attr}>${line || "&nbsp;"}</div>`);
  }
  return out.join("");
}

// initHome wires the command-center quick actions.
function initHome() {
  $("homeSpawn")?.addEventListener("click", () => openLaunch());
  $("homeGithub")?.addEventListener("click", () => { showPage("github"); location.hash = "github"; });
  $("heroSpawn")?.addEventListener("click", () => openLaunch());
  $("heroGithub")?.addEventListener("click", () => { showPage("github"); location.hash = "github"; });
  $("heroAlerts")?.addEventListener("click", openSettings);
}

// ---- ⌘K command palette (jump / spawn / summary / search) ----
let palItems = [], palSel = 0, palSearchToken = 0;
function palGo(p) { closePalette(); showPage(p); location.hash = p; }
function palJumpSession(sessionId) {
  closePalette();
  selectedId = sessionId;
  showPage("sessions"); location.hash = "sessions";
  if (lastState) { renderSessions(lastState.sessions, lastState.now); renderDetail(lastState.sessions, lastState.now); }
}
function palActions() {
  return [
    { label: "Launch session", sub: "new agent · repo picker", run: () => { closePalette(); openLaunch(); } },
    { label: "Daily summary", sub: "generate / refresh", run: () => { closePalette(); openSummary(); } },
    { label: "Settings", sub: "theme, alerts, summary defaults", run: () => { closePalette(); openSettings(); } },
    { label: "Go: Home", sub: "command center", run: () => palGo("home") },
    { label: "Go: Sessions", sub: "", run: () => palGo("sessions") },
    { label: "Go: Usage", sub: "", run: () => palGo("usage") },
    { label: "Go: Dev servers", sub: "", run: () => palGo("dev") },
    { label: "Go: Workspace", sub: "skills · worktrees", run: () => palGo("workspace") },
    { label: "Go: Audit", sub: "", run: () => palGo("audit") },
    { label: "Go: GitHub", sub: "", run: () => palGo("github") },
    { label: "Go: Summaries", sub: "", run: () => palGo("summaries") },
  ];
}
function openPalette() { openModal("palette"); $("palInput").value = ""; renderPalette(""); setTimeout(() => $("palInput").focus(), 0); }
function closePalette() { closeModal("palette"); }
function renderPalette(q) {
  q = q.trim(); const lq = q.toLowerCase();
  const items = [];
  palActions().forEach((a) => { if (!lq || a.label.toLowerCase().includes(lq)) items.push(a); });
  if (lq) {
    ((lastState && lastState.sessions) || [])
      .filter((s) => `${s.title} ${s.project} ${s.lastPrompt || ""}`.toLowerCase().includes(lq))
      .slice(0, 8)
      .forEach((s) => items.push({ label: s.title || s.project || "session", sub: "session · " + s.project, run: () => palJumpSession(s.sessionId) }));
  }
  palItems = items; palSel = 0; drawPalette();
  if (q.length >= 2) {
    const tok = ++palSearchToken;
    fetch("/api/search?q=" + encodeURIComponent(q), { cache: "no-store" })
      .then((r) => r.json())
      .then((hits) => {
        if (tok !== palSearchToken) return;
        (hits || []).slice(0, 10).forEach((h) =>
          palItems.push({ label: "🔎 " + (h.project || "match"), sub: h.snippet || "", run: () => palJumpSession(h.sessionId) })
        );
        drawPalette();
      })
      .catch(() => {});
  }
}
function drawPalette() {
  const el = $("palList");
  if (!el) return;
  el.innerHTML = palItems.length
    ? palItems.map((it, i) => `<div class="pal-item${i === palSel ? " sel" : ""}" data-i="${i}"><span class="pal-label">${esc(it.label)}</span><span class="pal-sub muted">${esc(it.sub || "")}</span></div>`).join("")
    : `<div class="pal-empty muted">No matches</div>`;
  el.querySelectorAll(".pal-item").forEach((d) =>
    d.addEventListener("click", () => { palSel = parseInt(d.dataset.i, 10); runPalSel(); })
  );
}
function runPalSel() { const it = palItems[palSel]; if (it && it.run) it.run(); }
function initPalette() {
  $("cmdBar")?.addEventListener("click", openPalette);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openPalette(); }
  });
  $("palette")?.addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });
  $("palInput")?.addEventListener("input", (e) => renderPalette(e.target.value));
  $("palInput")?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); drawPalette(); palScroll(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(0, palSel - 1); drawPalette(); palScroll(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalSel(); }
    else if (e.key === "Escape") { closePalette(); }
  });
}
function palScroll() { $("palList")?.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" }); }

// ---- daily summary: spawn an agent that runs the full flow + self-saves ----
function buildSummaryPrompt(start, end, author, repos, origin) {
  const saveUrl = `${origin}/api/summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&author=${encodeURIComponent(author)}&repos=${encodeURIComponent(repos)}`;
  return [
    `Produce my work summary for ${start} to ${end} (inclusive dates). GitHub author: ${author}. Repos: ${repos}.`,
    `Follow this flow:`,
    `1) GitHub authored artifacts: run gh search prs --author=${author} --created="${start}..${end}" --json repository,number,title,state,createdAt,url --limit 50 ; and gh search issues (same filters). For each repo, list ALL commits via the commit SEARCH API (search/commits, q=author:${author}+repo:<repo>+committer-date:${start}..${end}) — this is critical because the plain repo commits endpoint only shows commits reachable from HEAD and misses squash-merged/deleted branches.`,
    `2) Reviews with timestamps via GraphQL search (repo:<repo> reviewed-by:${author} updated:${start}..${end} is:pr), reading each review's submittedAt to place it on the correct day.`,
    `3) For each authored/merged PR, get its individual commits and body (gh pr view <n> --json title,body,headRefName ; gh api repos/<repo>/pulls/<n>/commits) for granular detail like "3 review rounds, 20 commits".`,
    `4) Local Claude Code work (REQUIRED — do not skip): fetch it from rook, which has already parsed and filtered it: curl -s "${origin}/api/claude-activity?start=${start}&end=${end}" . This returns JSON grouped by project, each with the user prompts (with timestamps) run in Claude Code sessions in the window (agentpeek excluded, noise/short prompts/dupes removed). You MUST incorporate this into the summary: for each day, add the local Claude Code work grouped by project, categorized as task work, PR review (skip — covered by step 2), or doc/research. This is first-class evidence alongside GitHub, not optional.`,
    `5) Cross-reference commits, PRs and sessions into a coherent story (e.g. "session investigating OOM at 06:30 -> PR #X pushed 11:27"); pull full PR/issue bodies for root-cause context.`,
    `Dedup: an authored PR goes in the task list (note review rounds inline); a reviewed PR only in the daily review count; a filed issue in the task list; a session that produced a PR is merged into that PR's bullet (do not list it separately).`,
    `Output has TWO sections, in this order:`,
    `SECTION 1 — "Detailed" (## Detailed): per-day sections in chronological order — task bullets for what you built/fixed/filed, a "Local Claude Code work" sub-list per project from step 4, then a Reviews line with count + names/titles; a daily review summary table (dates x counts); a TL;DR narrative of what shipped and why. Every day that has step-4 activity MUST show it.`,
    `SECTION 2 — "Work at a glance" (## Work at a glance): a scannable PER-DAY index. For EACH day in the window that had meaningful work, in chronological order, add a "### <YYYY-MM-DD>" subheading and under it list that day's work as SHORT self-explanatory headline TITLES only — NO descriptions, one line each — grouped under exactly three sub-subheadings: "#### Tasks" (things built/fixed/filed/deployed), "#### Docs & reports" (docs, release notes, plans, research, evidence reports), and "#### PR reviews" (PRs you reviewed — title + number). Rules: within a single day, every item appears exactly ONCE (no duplicates); each line is a self-contained title a reader understands without context (include the PR/issue number when there is one, e.g. "Fix aggregator OOM — FetchedAt dropped on ClickHouse read (PR #2247)"); SKIP small/trivial things (tweaks, one-off commands, tiny fixes) — only list meaningful pieces of work; omit any sub-subheading that would be empty for that day, and omit any day that had no meaningful work.`,
    `Style: no session IDs or session file paths; no emojis; include PR numbers + branch names; prefer root-cause over description; write markdown; use monospace for endpoints/paths/config keys.`,
    `Sanity checks: every PR you mention appeared in step 1 or 3; every issue in step 1; every commit date inside the window; the review table total equals the sum of daily review counts.`,
    `FINAL STEP: write the complete markdown summary to /tmp/rook-summary.md, then save it to rook by running exactly: curl -s -X POST "${saveUrl}" -H "Content-Type: binary/octet-stream" --data-binary @/tmp/rook-summary.md ; then print SUMMARY_SAVED.`,
  ].join("\n");
}

// applyDatePreset sets the summary date range from a named preset.
function applyDatePreset(preset) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  let start = new Date(now), end = new Date(now);
  if (preset === "yesterday") { start.setDate(now.getDate() - 1); end = new Date(start); }
  else if (preset === "week") { const dow = (now.getDay() + 6) % 7; start.setDate(now.getDate() - dow); } // Monday
  else if (preset === "month") { start = new Date(now.getFullYear(), now.getMonth(), 1); }
  $("sumStart").value = iso(start);
  $("sumEnd").value = iso(end);
}

async function openSummary() {
  const today = new Date().toISOString().slice(0, 10);
  if (!$("sumStart").value) $("sumStart").value = today;
  if (!$("sumEnd").value) $("sumEnd").value = today;
  // prefer saved server config, then localStorage
  let cfg = {};
  try { cfg = await (await fetch("/api/config")).json(); } catch (e) {}
  $("sumAuthor").value = cfg.summaryAuthor || localStorage.getItem("apSumAuthor") || "";
  $("sumRepos").value = cfg.summaryRepos || localStorage.getItem("apSumRepos") || "";
  populateCwdList();
  const dirs = [...new Set(((lastState && lastState.sessions) || []).map((s) => s.cwd).filter(Boolean))];
  $("sumCwd").value = cfg.summaryCwd || localStorage.getItem("apSumCwd") || dirs[0] || "";
  openModal("summary");
  loadSummaryOptions(); // fill author/repo dropdowns from known GitHub data
}

// loadSummaryOptions fills the author + repos datalists from rook's known
// GitHub username/orgs/repos (cached after the first load).
let sumOptsCache = null;
async function loadSummaryOptions() {
  const fill = (login, repos) => {
    $("sumAuthorList").innerHTML = login ? `<option value="${esc(login)}"></option>` : "";
    $("sumRepoList").innerHTML = repos.map((r) => `<option value="${esc(r)}"></option>`).join("");
    if (!$("sumAuthor").value && login) $("sumAuthor").value = login;
  };
  if (sumOptsCache) { fill(sumOptsCache.login, sumOptsCache.repos); return; }
  try {
    const d = await ghGet("/api/github/orgs"); // { login, orgs }
    const owners = [d.login, ...(d.orgs || [])].filter(Boolean);
    fill(d.login, []); // author available immediately; repos fill when fetched
    const lists = await Promise.all(
      owners.map((o) => ghGet("/api/github/repos?owner=" + encodeURIComponent(o)).catch(() => []))
    );
    const repos = [...new Set(lists.flat().map((r) => r && r.nameWithOwner).filter(Boolean))].sort();
    sumOptsCache = { login: d.login, repos };
    fill(d.login, repos);
  } catch (e) { /* datalists just stay empty — inputs still accept custom text */ }
}

// spawnSummary launches a summary agent for a window; save is an upsert server-
// side, so regenerating the same window refreshes its stored summary in place.
function spawnSummary(start, end, author, repos, cwd) {
  const prompt = buildSummaryPrompt(start, end, author, repos, location.origin);
  const base = ("summary-" + start + (start !== end ? "-" + end : "")).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 33);
  const name = base + "-" + (Date.now() % 100000); // unique tmux session name
  flash("spawning summary agent…");
  return spawnAgent({ name, cwd, agent: "claude", prompt }).then((ok) => {
    if (ok) { openTerm("", name, "summary " + start + (start !== end ? "…" + end : "")); setTimeout(poll, 700); }
    return ok;
  });
}

function generateSummary() {
  const start = $("sumStart").value, end = $("sumEnd").value;
  const author = $("sumAuthor").value.trim(), repos = $("sumRepos").value.trim();
  const cwd = $("sumCwd").value.trim();
  if (!start || !end) { flash("pick a date range", true); return; }
  if (!author) { flash("enter a GitHub author", true); return; }
  if (!cwd) { flash("set a working directory", true); return; }
  localStorage.setItem("apSumAuthor", author);
  localStorage.setItem("apSumRepos", repos);
  localStorage.setItem("apSumCwd", cwd);
  closeModal("summary");
  spawnSummary(start, end, author, repos, cwd);
}

function initSummary() {
  $("homeSummary2")?.addEventListener("click", openSummary);
  $("sumNew")?.addEventListener("click", openSummary);
  $("sumRefresh")?.addEventListener("click", () => { renderSummaries(); if (sumSelId != null) loadSummary(sumSelId); flash("refreshed"); });
  $("summaryClose")?.addEventListener("click", () => closeModal("summary"));
  $("summary")?.addEventListener("click", (e) => { if (e.target.id === "summary") closeModal("summary"); });
  $("sumGo")?.addEventListener("click", generateSummary);
  document.querySelectorAll("#summary .preset").forEach((b) =>
    b.addEventListener("click", () => applyDatePreset(b.dataset.preset))
  );
}

let sumSelId = null;
const sumChecked = new Set(); // ids checked for bulk delete
async function renderSummaries() {
  const list = $("sumList");
  if (!list) return;
  try {
    const items = await (await fetch("/api/summaries", { cache: "no-store" })).json();
    $("sumCount").textContent = items.length ? `${items.length}` : "";
    // prune selections for ids that no longer exist
    const liveIds = new Set(items.map((s) => s.id));
    [...sumChecked].forEach((id) => { if (!liveIds.has(id)) sumChecked.delete(id); });
    if (!items.length) {
      list.innerHTML = `<li class="empty">No summaries yet — click <b>New</b> to generate one.</li>`;
      sumSelId = null;
      $("sumView").innerHTML = `<p class="empty">Select a summary to read it, or generate a new one.</p>`;
      $("sumViewTitle").textContent = "Summary";
      ["sumCopy", "sumDownload", "sumRegen", "sumDelete"].forEach((id) => { const b = $(id); if (b) b.hidden = true; });
      renderSumBulk();
      return;
    }
    // if the summary being viewed was deleted, clear the viewer
    if (sumSelId != null && !liveIds.has(sumSelId)) {
      sumSelId = null;
      $("sumView").innerHTML = `<p class="empty">Select a summary to read it.</p>`;
      $("sumViewTitle").textContent = "Summary";
      ["sumCopy", "sumDownload", "sumRegen", "sumDelete"].forEach((id) => { const b = $(id); if (b) b.hidden = true; });
    }
    list.innerHTML = items.map((s) => `<li class="ghrepo sumitem${s.id === sumSelId ? " sel" : ""}" data-id="${s.id}">
      <div class="sumitem-top">
        <input type="checkbox" class="sum-cb" data-id="${s.id}"${sumChecked.has(s.id) ? " checked" : ""} title="select for bulk delete" />
        <div class="ghrepo-name">${esc(s.start)}${s.end && s.end !== s.start ? " → " + esc(s.end) : ""}</div>
      </div>
      <div class="ghrepo-meta muted">${esc(s.author || "")}${s.repos ? " · " + esc(s.repos) : ""} · ${ago(s.createdAt, Date.now())}</div>
      <div class="ghrepo-desc muted">${esc(s.snippet || "")}</div>
    </li>`).join("");
    list.querySelectorAll(".sumitem").forEach((li) =>
      li.addEventListener("click", (e) => { if (e.target.closest(".sum-cb")) return; loadSummary(parseInt(li.dataset.id, 10)); })
    );
    list.querySelectorAll(".sum-cb").forEach((cb) =>
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        const id = parseInt(cb.dataset.id, 10);
        if (cb.checked) sumChecked.add(id); else sumChecked.delete(id);
        cb.closest(".sumitem").classList.toggle("checked", cb.checked);
        renderSumBulk();
      })
    );
    renderSumBulk();
    // auto-open the most recent when nothing is selected yet
    if (sumSelId == null && items.length) loadSummary(items[0].id);
  } catch (e) {
    list.innerHTML = `<li class="gherr">couldn't load summaries</li>`;
  }
}

// renderSumBulk shows the bulk-delete bar when summaries are checked.
function renderSumBulk() {
  const bar = $("sumBulk");
  if (!bar) return;
  const n = sumChecked.size;
  if (!n) { bar.innerHTML = ""; return; }
  bar.innerHTML = `<span class="bulk-n">${n} selected</span>
    <button class="btn danger" id="sumBulkDel">Delete ${n}</button>
    <button class="btn ghost" id="sumBulkClear">Clear</button>`;
  $("sumBulkDel").addEventListener("click", deleteSelectedSummaries);
  $("sumBulkClear").addEventListener("click", () => { sumChecked.clear(); renderSummaries(); });
}

let sumBulkBusy = false;
async function deleteSelectedSummaries() {
  if (sumBulkBusy) return; // guard against a double-click re-firing the batch
  const ids = [...sumChecked];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} summar${ids.length === 1 ? "y" : "ies"}? This can't be undone.`)) return;
  sumBulkBusy = true;
  const btn = $("sumBulkDel");
  if (btn) { btn.disabled = true; btn.textContent = "Deleting…"; }
  let ok = 0;
  for (const id of ids) {
    try {
      const res = await fetch("/api/summary?id=" + id, { method: "DELETE" });
      if (res.ok) ok++;
    } catch (e) {}
    if (id === sumSelId) sumSelId = null;
  }
  sumChecked.clear();
  sumBulkBusy = false;
  flash(`deleted ${ok} summar${ok === 1 ? "y" : "ies"}`, ok < ids.length);
  renderSummaries();
}

async function loadSummary(id) {
  sumSelId = id;
  const view = $("sumView");
  view.innerHTML = `<p class="empty">loading…</p>`;
  try {
    const s = await (await fetch("/api/summary?id=" + id, { cache: "no-store" })).json();
    $("sumViewTitle").textContent = s.start + (s.end && s.end !== s.start ? " → " + s.end : "");
    view.innerHTML = mdToHtml(s.content || "");
    const copy = $("sumCopy"), del = $("sumDelete"), regen = $("sumRegen"), dl = $("sumDownload");
    copy.hidden = false; del.hidden = false; regen.hidden = false; dl.hidden = false;
    copy.onclick = () => { navigator.clipboard?.writeText(s.content || ""); flash("copied (paste into Slack/docs)"); };
    dl.onclick = () => {
      const blob = new Blob([s.content || ""], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `summary-${s.start}${s.end !== s.start ? "_" + s.end : ""}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    regen.onclick = () => {
      const cwd = localStorage.getItem("apSumCwd") || "";
      if (!cwd) {
        // no remembered working dir — open the modal prefilled so they can set one
        openSummary();
        $("sumStart").value = s.start; $("sumEnd").value = s.end;
        $("sumAuthor").value = s.author || ""; $("sumRepos").value = s.repos || "";
        flash("set a working directory, then Generate", true);
        return;
      }
      if (!confirm(`Regenerate the summary for ${s.start}${s.end !== s.start ? " → " + s.end : ""}? It refreshes this saved summary in place.`)) return;
      spawnSummary(s.start, s.end, s.author || localStorage.getItem("apSumAuthor") || "", s.repos || "", cwd);
    };
    del.onclick = async () => {
      if (!confirm("Delete this summary?")) return;
      await fetch("/api/summary?id=" + id, { method: "DELETE" });
      sumSelId = null; view.innerHTML = `<p class="empty">Select a summary to read it.</p>`;
      copy.hidden = true; del.hidden = true; regen.hidden = true; dl.hidden = true; $("sumViewTitle").textContent = "Summary";
      renderSummaries();
    };
    renderSummaries();
  } catch (e) { view.innerHTML = `<p class="gherr">couldn't load this summary</p>`; }
}

// mdToHtml is a compact Markdown renderer (headings, bold/italic/code, lists,
// tables, code fences, blockquotes, hr, links) — enough for the summary output.
function mdToHtml(md) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = String(md).replace(/\r/g, "").split("\n");
  let html = "", i = 0, inCode = false, listType = "";
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = ""; } };
  while (i < lines.length) {
    let ln = lines[i];
    if (/^```/.test(ln)) {
      if (!inCode) { closeList(); html += "<pre class='md-pre'><code>"; inCode = true; }
      else { html += "</code></pre>"; inCode = false; }
      i++; continue;
    }
    if (inCode) { html += esc(ln) + "\n"; i++; continue; }
    // table: a header row followed by a |---| separator
    if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(ln);
      html += "<table class='md-table'><thead><tr>" + head.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        html += "<tr>" + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        i++;
      }
      html += "</tbody></table>";
      continue;
    }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); html += `<h${h[1].length} class="md-h">${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^\s*[-*]\s+/.test(ln)) {
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += `<li>${inline(ln.replace(/^\s*[-*]\s+/, ""))}</li>`; i++; continue;
    }
    if (/^\s*\d+\.\s+/.test(ln)) {
      if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
      html += `<li>${inline(ln.replace(/^\s*\d+\.\s+/, ""))}</li>`; i++; continue;
    }
    if (/^\s*>\s?/.test(ln)) { closeList(); html += `<blockquote>${inline(ln.replace(/^\s*>\s?/, ""))}</blockquote>`; i++; continue; }
    if (/^\s*---+\s*$/.test(ln)) { closeList(); html += "<hr>"; i++; continue; }
    if (ln.trim() === "") { closeList(); i++; continue; }
    closeList();
    html += `<p>${inline(ln)}</p>`;
    i++;
  }
  closeList();
  if (inCode) html += "</code></pre>";
  return html;
}

// wireHomeJump makes any .hjump element select its session and open Sessions.
function wireHomeJump(root) {
  root.querySelectorAll(".hjump").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedId = el.dataset.id;
      if (lastState) { renderSessions(lastState.sessions, lastState.now); renderDetail(lastState.sessions, lastState.now); }
      showPage("sessions"); location.hash = "sessions";
      document.querySelector(".grid")?.scrollIntoView({ behavior: "smooth" });
    })
  );
}

function homeNeedCard(s) {
  return `<div class="hneed" data-id="${s.sessionId}">
    <div class="hneed-h">
      <span class="sk-siren"></span>
      <span class="hneed-proj hjump" data-id="${s.sessionId}">${esc(s.project || "agent")}</span>
      ${provBadge(s.provider)}<span class="badge b-waiting">waiting</span>
    </div>
    <div class="hneed-title hjump" data-id="${s.sessionId}">${esc(s.title || "session")}</div>
    <div class="hneed-ask">${esc(s.asking || s.lastPrompt || "waiting for your input")}</div>
    ${controlsHTML(s)}
  </div>`;
}

function homeRow(s, now) {
  const st = statusOf(s);
  const sub = (st === "busy" || st === "shell") && s.activity ? s.activity : (s.lastPrompt || s.cwd || "");
  const actions = (s.controllable && s.alive)
    ? `<div class="hrow-actions">
        <button class="hrow-btn" data-term="${s.sessionId}" title="Open live terminal">${icon("terminal")}</button>
        <button class="hrow-btn danger" data-kill="${s.sessionId}" title="Stop agent">${icon("stop")}</button>
      </div>`
    : "";
  return `<div class="hrow hjump" data-id="${s.sessionId}">
    <span class="sdot s-${st}"></span>
    <div class="hrow-main">
      <div class="hrow-title">${esc(s.title || s.project || "session")}</div>
      <div class="hrow-sub muted">${provBadge(s.provider)}<span class="hrow-proj">${esc(s.project)}</span> <span class="badge b-${st}">${st}</span> · ${ago(s.updatedAt, now)}</div>
      ${sub ? `<div class="hrow-sub hrow-act muted">${esc(sub)}</div>` : ""}
    </div>
    ${actions}
    <span class="stok">${fmtTokens(s.tokens7d || s.tokensTotal)}</span>
  </div>`;
}

// wireHomeActions wires the inline Terminal / Stop buttons on Home cards.
function wireHomeActions(root) {
  const find = (id) => (lastState && lastState.sessions || []).find((x) => x.sessionId === id);
  root.querySelectorAll("[data-term]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = find(b.dataset.term);
      if (s) openTerm(s.sessionId, s.tmuxPane, s.title || s.project);
    })
  );
  root.querySelectorAll("[data-kill]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = find(b.dataset.kill);
      killSession(b.dataset.kill, s ? (s.title || s.project) : "");
    })
  );
}

// ---- Board: every agent by state, with per-card actions + task chains ----
let boardChains = [];
function boardColumn(s) {
  const st = statusOf(s);
  if (st === "waiting" || (s.health && s.health.level === "alert")) return "needs";
  if (s.alive && (st === "busy" || st === "shell")) return "working";
  if ((s.cwd || "").includes("/.rook/worktrees/")) return "review"; // in an isolated worktree, not actively working
  return "done";
}
async function renderBoard(sessions, now) {
  const board = $("board");
  if (!board) return;
  try { boardChains = await (await fetch("/api/chains", { cache: "no-store" })).json(); } catch (e) { boardChains = []; }
  if (window.renderBoardV2) {
    renderBoardV2(board, { sessions: sessions || [], chains: boardChains || [] }, {
      onAllow: (id) => respond(id, "allow"),
      onDeny: (id) => respond(id, "deny"),
      onTerminal: (id) => { const s = (sessions || []).find((x) => x.sessionId === id); if (s && s.tmuxPane) openTerm(s.sessionId, s.tmuxPane, s.title || s.project); },
      onDiff: (id) => { const s = (sessions || []).find((x) => x.sessionId === id); if (s && s.cwd) openDiff(s.cwd, s.title || s.project, s.tmuxPane); },
      onReview: (id) => { const s = (sessions || []).find((x) => x.sessionId === id); if (s && s.cwd) openDiff(s.cwd, s.title || s.project, s.tmuxPane); },
      onOpen: (id) => { selectedId = id; showPage("sessions"); location.hash = "sessions"; if (lastState) { renderSessions(lastState.sessions, lastState.now); renderDetail(lastState.sessions, lastState.now); } },
      onNewTask: () => { $("chainBtn")?.click(); },
      onMove: () => {},
    });
    return;
  }
  const cols = { needs: [], working: [], review: [], done: [] };
  (sessions || []).forEach((s) => cols[boardColumn(s)].push(s));
  const queued = [];
  boardChains.forEach((c) => (c.steps || []).forEach((step) => { if (step.status === "pending") queued.push({ chain: c.title, step }); }));
  const meta = [
    ["queued", "Queued", queued.length],
    ["working", "Working", cols.working.length],
    ["needs", "Needs you", cols.needs.length],
    ["review", "Review", cols.review.length],
    ["done", "Idle / done", cols.done.length],
  ];
  board.innerHTML = meta.map(([key, label, n]) => `
    <div class="bcol bcol-${key}">
      <div class="bcol-head"><span>${label}</span><span class="bcol-n">${n}</span></div>
      <div class="bcol-body" data-col="${key}">
        ${key === "queued"
      ? (queued.length ? queued.map((q) => `<div class="bcard bcard-queued"><div class="bc-title">${esc(q.step.name)}</div><div class="bc-meta muted">${esc(q.chain)} · ${esc(q.step.prompt || "")}</div></div>`).join("") : `<p class="empty">No queued steps.</p>`)
      : (cols[key].length ? cols[key].map((s) => boardCard(s, now)).join("") : `<p class="empty">—</p>`)}
      </div>
    </div>`).join("");
  $("boardCount") && ($("boardCount").textContent = "");
  // wire card actions
  board.querySelectorAll(".bcard[data-id]").forEach((card) => {
    const id = card.dataset.id;
    const s = (sessions || []).find((x) => x.sessionId === id);
    card.querySelector(".bc-open")?.addEventListener("click", (e) => { e.stopPropagation(); if (s && s.tmuxPane) openTerm(s.sessionId, s.tmuxPane, s.title || s.project); });
    card.querySelector(".bc-diff")?.addEventListener("click", (e) => { e.stopPropagation(); if (s && s.cwd) openDiff(s.cwd, s.title || s.project); });
    card.querySelector(".bc-allow")?.addEventListener("click", (e) => { e.stopPropagation(); respond(id, "allow"); });
    card.querySelector(".bc-deny")?.addEventListener("click", (e) => { e.stopPropagation(); respond(id, "deny"); });
    card.addEventListener("click", () => { selectedId = id; showPage("sessions"); location.hash = "sessions"; if (lastState) { renderSessions(lastState.sessions, lastState.now); renderDetail(lastState.sessions, lastState.now); } });
  });
}
function boardCard(s, now) {
  const st = statusOf(s);
  const waiting = st === "waiting";
  return `<div class="bcard" data-id="${s.sessionId}">
    <div class="bc-top"><span class="sdot s-${st}"></span><span class="bc-title">${esc(s.title || s.project || "session")}</span></div>
    <div class="bc-meta muted">${provBadge(s.provider)}${esc(s.project || "")}${s.health ? healthChip(s) : ""}</div>
    <div class="bc-acts">
      ${waiting ? `<button class="btn allow bc-allow">Allow</button><button class="btn danger bc-deny">Deny</button>` : ""}
      ${s.controllable ? `<button class="btn bc-open">Terminal</button>` : ""}
      ${s.cwd ? `<button class="btn bc-diff">Diff</button>` : ""}
    </div>
  </div>`;
}
function initBoard() {
  $("chainBtn")?.addEventListener("click", () => { $("chCwd").value = ""; $("chTitle").value = ""; $("chSteps").value = ""; populateCwdList(); openModal("chain"); });
  $("chainClose")?.addEventListener("click", () => closeModal("chain"));
  $("chCancel")?.addEventListener("click", () => closeModal("chain"));
  $("chGo")?.addEventListener("click", async () => {
    const cwd = $("chCwd").value.trim();
    const steps = $("chSteps").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => ({ name: "step" + (i + 1), prompt: l }));
    if (!cwd || !steps.length) { flash("working directory and at least one step required", true); return; }
    try {
      const res = await fetch("/api/chain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: $("chTitle").value.trim(), cwd, worktree: $("chWorktree").checked, steps }) });
      if (!res.ok) { flash(await apiErr(res), true); return; }
      closeModal("chain");
      flash(`chain started · ${steps.length} steps`);
      showPage("board"); location.hash = "board";
      setTimeout(poll, 600);
    } catch (e) { flash("couldn't start chain", true); }
  });
}

function renderHome(sessions, now) {
  if (!$("homeNeeds")) return;

  // first-run welcome when rook hasn't seen any agents yet
  const hero = $("homeHero"), secs = document.querySelector(".home-sections"), sum = $("homeSummary");
  if ((sessions || []).length === 0) {
    if (hero) hero.hidden = false;
    if (secs) secs.style.display = "none";
    if (sum) sum.style.display = "none";
    return;
  }
  if (hero) hero.hidden = true;
  if (secs) secs.style.display = "";
  if (sum) sum.style.display = "";

  const alive = (sessions || []).filter((s) => s.alive);
  const waiting = alive.filter((s) => s.status === "waiting");
  const working = alive.filter((s) => s.status === "busy" || s.status === "shell");
  const idle = alive.filter((s) => s.status === "idle");
  const done = (sessions || []).filter((s) => !s.alive).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5);

  $("homeSummary").innerHTML = [
    `<div class="hchip${waiting.length ? " hot" : ""}"><b>${waiting.length}</b> need you</div>`,
    `<div class="hchip"><b>${working.length}</b> working</div>`,
    `<div class="hchip"><b>${idle.length}</b> idle</div>`,
    `<div class="hchip"><b>${alive.length}</b> live agent${alive.length === 1 ? "" : "s"}</div>`,
  ].join("");
  $("homeNeedN").textContent = waiting.length ? `(${waiting.length})` : "";
  $("homeWorkN").textContent = working.length ? `(${working.length})` : "";
  $("homeIdleN").textContent = (idle.length + done.length) ? `(${idle.length + done.length})` : "";

  const needs = $("homeNeeds");
  // don't wipe a reply box the user is typing into
  if (!(isTyping() && needs.contains(document.activeElement))) {
    needs.innerHTML = waiting.length
      ? waiting.map(homeNeedCard).join("")
      : `<p class="empty">Nothing needs you right now.</p>`;
    wireControls(needs);
    wireHomeJump(needs);
  }

  const wEl = $("homeWorking");
  wEl.innerHTML = working.length ? working.map((s) => homeRow(s, now)).join("") : `<p class="empty">No agents working.</p>`;
  wireHomeJump(wEl); wireHomeActions(wEl);

  const idleAll = [...idle, ...done];
  const iEl = $("homeIdle");
  iEl.innerHTML = idleAll.length ? idleAll.map((s) => homeRow(s, now)).join("") : `<p class="empty">No idle or recent sessions.</p>`;
  wireHomeJump(iEl); wireHomeActions(iEl);
}

// populateCwdList fills the spawn dir picker with directories from open sessions.
function populateCwdList() {
  const dl = $("cwdList");
  if (!dl || !lastState) return;
  const dirs = [...new Set((lastState.sessions || []).map((s) => s.cwd).filter(Boolean))];
  dl.innerHTML = dirs.map((d) => `<option value="${esc(d)}"></option>`).join("");
}

// ---- orchestration: live terminals (multi-session tabs) ----
// term.list holds every open terminal {target, title}; control is by tmux target
// so it works for any session, including freshly handed-off agents.
// ---- interactive terminal: xterm.js <-> WebSocket PTY (tmux attach) ----
// A real terminal: keystrokes stream to a PTY on the server, output streams
// back. Arrow keys, tab-completion, Ctrl-sequences, and full-screen TUIs all
// work — same as iTerm attached to the agent.
const term = { list: [], active: -1 };
const TERM_THEME = {
  background: "#16141d", foreground: "#efeaf0", cursor: "#f0543c", cursorAccent: "#16141d",
  selectionBackground: "rgba(240,84,60,.30)",
  black: "#2b2637", red: "#f0433f", green: "#3ecf8e", yellow: "#e8a13a",
  blue: "#6b8cf0", magenta: "#c98af5", cyan: "#5fd0d0", white: "#ada6bd",
  brightBlack: "#766f86", brightRed: "#ff7e63", brightGreen: "#5fe0a5", brightYellow: "#ffc06a",
  brightBlue: "#8aa5f5", brightMagenta: "#dca8ff", brightCyan: "#8ae5e5", brightWhite: "#efeaf0",
};

function activeTerm() { return term.active >= 0 && term.active < term.list.length ? term.list[term.active] : null; }

function termWsURL(target, cols, rows) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const tok = new URLSearchParams(location.search).get("token");
  return `${proto}://${location.host}/ws/term?target=${encodeURIComponent(target)}&cols=${cols}&rows=${rows}${tok ? "&token=" + encodeURIComponent(tok) : ""}`;
}

// openTerm opens (or focuses) a session's live interactive terminal as a tab.
function openTerm(_sessionId, target, title) {
  if (!target) return;
  if (typeof Terminal === "undefined") { flash("terminal library not loaded", true); return; }
  let i = term.list.findIndex((t) => t.target === target);
  if (i < 0) i = createTermTab(target, title || target);
  else if (title) term.list[i].title = title;
  term.active = i;
  const navtab = document.querySelector('.tab[data-page="term"]');
  if (navtab) navtab.hidden = false;
  location.hash = "term";
  showPage("term"); // showActiveTerm() runs from showPage -> startTermPoll shim
}

function createTermTab(target, title) {
  const host = document.createElement("div");
  host.className = "xterm-host";
  $("termMount").appendChild(host);
  const xt = new Terminal({
    fontFamily: '"SF Mono","JetBrains Mono",Menlo,monospace', fontSize: 12.5, lineHeight: 1.15,
    cursorBlink: true, scrollback: 8000, theme: TERM_THEME, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  xt.loadAddon(fit);
  xt.open(host);
  const rec = { target, title, xt, fit, host, ws: null };
  term.list.push(rec);
  xt.onData((d) => { if (rec.ws && rec.ws.readyState === 1) rec.ws.send(d); });
  // Refit + resize tmux whenever the panel actually changes size (first real
  // layout, window resize, tab switch) so the pane always fills the terminal
  // instead of leaving a black void below tmux's status bar.
  rec.ro = new ResizeObserver(() => { if (activeTerm() === rec) refitTerm(rec); });
  rec.ro.observe(host);
  connectTerm(rec);
  return term.list.length - 1;
}

function refitTerm(rec) {
  try {
    rec.fit.fit();
    sendTermResize(rec);
  } catch (e) {}
}

function connectTerm(rec) {
  try { rec.fit.fit(); } catch (e) {}
  const ws = new WebSocket(termWsURL(rec.target, rec.xt.cols || 120, rec.xt.rows || 32));
  ws.binaryType = "arraybuffer";
  rec.ws = ws;
  // once connected, push the real size (the initial URL size was measured before
  // the panel was laid out) so tmux resizes to fill immediately.
  ws.onopen = () => setTimeout(() => refitTerm(rec), 60);
  ws.onmessage = (e) => rec.xt.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  ws.onclose = () => rec.xt.write("\r\n\x1b[38;5;244m[detached — the agent's session may have ended. Reopen from Sessions.]\x1b[0m\r\n");
  ws.onerror = () => {};
}

function renderTermTabs() {
  const el = $("termTabs");
  if (!el) return;
  if (term.list.length === 0) { el.innerHTML = `<span class="muted" style="padding:9px 14px;font-size:12px">no open terminals</span>`; return; }
  el.innerHTML = term.list.map((t, i) => `<div class="termtab${i === term.active ? " on" : ""}" data-i="${i}">
      <span class="tt-name">${esc(t.title)}</span>
      <button class="tt-x" data-close="${i}" title="close tab">${icon("x")}</button>
    </div>`).join("");
  el.querySelectorAll(".termtab").forEach((tt) =>
    tt.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) return; term.active = parseInt(tt.dataset.i, 10); showActiveTerm(); }));
  el.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); closeTermTab(parseInt(b.dataset.close, 10)); }));
}

function showActiveTerm() {
  renderTermTabs();
  const cur = activeTerm();
  $("termTitle").textContent = cur ? "Terminal · " + cur.title : "Terminal";
  term.list.forEach((t) => { t.host.style.display = t === cur ? "block" : "none"; });
  focusActiveTerm();
}

function focusActiveTerm() {
  const t = activeTerm();
  if (!t) return;
  requestAnimationFrame(() => { try { t.fit.fit(); sendTermResize(t); t.xt.focus(); } catch (e) {} });
}

function sendTermResize(t) {
  if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ resize: [t.xt.cols, t.xt.rows] }));
}

function closeTermTab(i) {
  const t = term.list[i];
  if (t) { try { t.ro && t.ro.disconnect(); } catch (e) {} try { t.ws && t.ws.close(); } catch (e) {} try { t.xt.dispose(); } catch (e) {} t.host.remove(); }
  term.list.splice(i, 1);
  if (term.active >= term.list.length) term.active = term.list.length - 1;
  if (term.list.length === 0) {
    renderTermTabs();
    const navtab = document.querySelector('.tab[data-page="term"]');
    if (navtab) navtab.hidden = true;
    location.hash = "sessions"; showPage("sessions");
    return;
  }
  showActiveTerm();
}

// shims so showPage()'s existing start/stop calls still drive the view
function startTermPoll() { showActiveTerm(); }
function stopTermPoll() {}

function termTick() {} // legacy no-op (terminal now streams over WebSocket)

// ---- ANSI → HTML (colourize the terminal like iTerm) ----
// xterm 16-colour palette tuned for the dark terminal background.
const ANSI16 = [
  "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d7dbe3",
  "#7f8797", "#ff7b86", "#b6e3a1", "#f0d399", "#82c0ff", "#e39bef", "#74d0da", "#ffffff",
];
function ansi256(n) {
  if (n < 16) return ANSI16[n];
  if (n < 232) {
    n -= 16;
    const s = [0, 95, 135, 175, 215, 255];
    return `rgb(${s[Math.floor(n / 36) % 6]},${s[Math.floor(n / 6) % 6]},${s[n % 6]})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}
function ansiEsc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function ansiToHtml(raw) {
  // drop non-colour escape sequences (cursor moves, OSC titles, etc.); keep SGR (…m)
  raw = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*([@-ln-~])/g, "");
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
  const apply = (codeStr) => {
    const codes = (codeStr || "0").split(";").map((x) => parseInt(x || "0", 10));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { st.fg = st.bg = null; st.bold = st.dim = st.italic = st.underline = st.inverse = false; }
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c === 27) st.inverse = false;
      else if (c >= 30 && c <= 37) st.fg = ANSI16[c - 30];
      else if (c >= 90 && c <= 97) st.fg = ANSI16[c - 90 + 8];
      else if (c >= 40 && c <= 47) st.bg = ANSI16[c - 40];
      else if (c >= 100 && c <= 107) st.bg = ANSI16[c - 100 + 8];
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) {
        const which = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) { st[which] = ansi256(codes[i + 2]); i += 2; }
        else if (codes[i + 1] === 2) { st[which] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      }
    }
  };
  const css = () => {
    let fg = st.fg, bg = st.bg;
    if (st.inverse) { fg = st.bg || "#0c0e12"; bg = st.fg || "#d7dbe3"; }
    const p = [];
    if (fg) p.push("color:" + fg);
    if (bg) p.push("background:" + bg);
    if (st.bold) p.push("font-weight:600");
    if (st.dim) p.push("opacity:.6");
    if (st.italic) p.push("font-style:italic");
    if (st.underline) p.push("text-decoration:underline");
    return p.join(";");
  };
  let html = "";
  const parts = raw.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (part === "") continue;
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (m) { apply(m[1]); continue; }
    const style = css();
    html += style ? `<span style="${style}">${ansiEsc(part)}</span>` : ansiEsc(part);
  }
  return html;
}

// termSendAction writes a control sequence straight into the active terminal's
// PTY over the WebSocket (the terminal is fully interactive; these are just
// convenience shortcuts). action -> raw bytes.
function termSendAction(action, value) {
  const t = activeTerm();
  if (!t || !t.ws || t.ws.readyState !== 1) { flash("no active terminal", true); return; }
  const seq = { allow: "\r", deny: "\x1b", interrupt: "\x03", key: value || "" }[action];
  if (seq != null) t.ws.send(seq);
  t.xt.focus();
}

function initTerm() {
  $("tcAllow")?.addEventListener("click", () => termSendAction("allow"));
  $("tcDeny")?.addEventListener("click", () => termSendAction("deny"));
  document.querySelectorAll(".tc-key").forEach((b) =>
    b.addEventListener("click", () => termSendAction("key", b.dataset.key)));
  $("termInterrupt")?.addEventListener("click", () => termSendAction("interrupt"));
  $("termKill")?.addEventListener("click", async () => {
    const t = activeTerm();
    if (!t) return;
    if (!confirm(`Stop the agent in "${t.title}"? This ends the agent.`)) return;
    try {
      await fetch("/api/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: t.target }) });
      flash("agent stopped");
    } catch (e) { flash("stop failed", true); }
    closeTermTab(term.active);
    setTimeout(poll, 400);
  });
  // refit the active terminal when the window resizes
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => focusActiveTerm(), 120); });
}

// ---- theme switcher ----
const THEMES = ["graphite", "light", "coffee", "coffee-light"];
let curTheme = localStorage.getItem("apTheme") || "graphite";

function applyTheme(t) {
  if (t === "graphite") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

function initTheme() {
  applyTheme(curTheme); // theme is now changed from Settings
}

// ---- notices: onboarding + tmux setup ----
function renderNotices(st) {
  const el = $("notices");
  if (!el) return;
  let html = "";
  if (!localStorage.getItem("apOnboarded")) {
    html += `<div class="notice info">
      <span><b>rook</b> watches all your AI coding agents — <span class="sdot s-waiting" style="display:inline-block;vertical-align:middle"></span> <b>waiting</b> means one needs you. Click a session for details, or <a href="#" id="noHelp">see the guide</a>.</span>
      <button class="notice-x" data-dismiss="apOnboarded">Got it</button></div>`;
  }
  if (st.tmuxAvailable === false && !localStorage.getItem("apTmuxDismissed")) {
    html += `<div class="notice warn">
      <span>Control features (Allow/Deny, live Terminal, Spawn) need <b>tmux</b>. Install with <code>brew install tmux</code>, then spawn agents from rook. Monitoring works without it.</span>
      <button class="notice-x" data-dismiss="apTmuxDismissed">Dismiss</button></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll("[data-dismiss]").forEach((b) =>
    b.addEventListener("click", () => { localStorage.setItem(b.dataset.dismiss, "1"); renderNotices(st); })
  );
  $("noHelp")?.addEventListener("click", (e) => { e.preventDefault(); openModal("help"); });
}

// ---- modals: settings + help ----
function openModal(id) { const m = $(id); if (m) m.hidden = false; }
function closeModal(id) { const m = $(id); if (m) m.hidden = true; }

function initModals() {
  $("helpBtn")?.addEventListener("click", () => openModal("help"));
  $("helpClose")?.addEventListener("click", () => closeModal("help"));
  $("settingsBtn")?.addEventListener("click", openSettings);
  $("settingsClose")?.addEventListener("click", () => closeModal("settings"));
  ["settings", "help"].forEach((id) =>
    $(id)?.addEventListener("click", (e) => { if (e.target.id === id) closeModal(id); })
  );
  $("setSave")?.addEventListener("click", saveSettings);
  $("setTestChat")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/webhook/test", { method: "POST" });
      flash(res.ok ? "test sent to your chat" : await apiErr(res), !res.ok);
    } catch (e) { flash("test failed", true); }
  });
  $("setAlerts")?.addEventListener("click", toggleAlerts);
  $("setTheme")?.addEventListener("change", () => {
    curTheme = $("setTheme").value; localStorage.setItem("apTheme", curTheme); applyTheme(curTheme);
  });
}

async function openSettings() {
  $("setTheme").value = curTheme;
  updateAlertsUI();
  $("setCap5").value = (parseFloat(localStorage.getItem("apLimit5h") || "0") / 1e6) || "";
  $("setCap7").value = (parseFloat(localStorage.getItem("apLimit7d") || "0") / 1e6) || "";
  try {
    const c = await (await fetch("/api/config")).json();
    $("setNtfy").value = c.ntfy || "";
    $("setSumAuthor").value = c.summaryAuthor || "";
    $("setSumRepos").value = c.summaryRepos || "";
    $("setSumCwd").value = c.summaryCwd || "";
    $("setSumSchedule").value = c.summarySchedule || "";
    $("setAllowWrite").checked = !!c.allowWrite;
    $("setEditor").value = c.editor || "";
    $("setSlack").value = c.slackWebhook || "";
    $("setDiscord").value = c.discordWebhook || "";
    $("setLinear").value = c.linearToken || "";
    $("setJiraBase").value = c.jiraBase || "";
    $("setJiraEmail").value = c.jiraEmail || "";
    $("setJiraToken").value = c.jiraToken || "";
  } catch (e) {}
  openModal("settings");
}

function saveSettings() {
  curTheme = $("setTheme").value; localStorage.setItem("apTheme", curTheme); applyTheme(curTheme);
  const c5 = parseFloat($("setCap5").value); if (c5 > 0) localStorage.setItem("apLimit5h", String(c5 * 1e6)); else localStorage.removeItem("apLimit5h");
  const c7 = parseFloat($("setCap7").value); if (c7 > 0) localStorage.setItem("apLimit7d", String(c7 * 1e6)); else localStorage.removeItem("apLimit7d");
  fetch("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ntfy: $("setNtfy").value.trim(),
      summaryAuthor: $("setSumAuthor").value.trim(),
      summaryRepos: $("setSumRepos").value.trim(),
      summaryCwd: $("setSumCwd").value.trim(),
      summarySchedule: $("setSumSchedule").value.trim(),
      allowWrite: $("setAllowWrite").checked,
      editor: $("setEditor").value,
      slackWebhook: $("setSlack").value.trim(),
      discordWebhook: $("setDiscord").value.trim(),
      linearToken: $("setLinear").value.trim(),
      jiraBase: $("setJiraBase").value.trim(),
      jiraEmail: $("setJiraEmail").value.trim(),
      jiraToken: $("setJiraToken").value.trim(),
    }),
  }).catch(() => {});
  closeModal("settings");
  flash("settings saved");
  if (lastState) { renderWindows(lastState.windows, lastState.now); renderUsage(lastState.sessions, lastState.windows); }
}

// ---- desktop notifications (browser) ----
let alertsOn = localStorage.getItem("apAlerts") === "1";
let knownWaiting = new Set();

// toggleAlerts is driven from Settings (no separate top-bar bell anymore).
async function toggleAlerts() {
  if (!("Notification" in window)) {
    flash("this browser can't show notifications", true);
    return;
  }
  if (!alertsOn) {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { flash("notification permission denied", true); updateAlertsUI(); return; }
    alertsOn = true;
    localStorage.setItem("apAlerts", "1");
    flash("alerts on");
    new Notification("rook alerts on", { body: "You'll be notified when an agent needs you." });
  } else {
    alertsOn = false;
    localStorage.setItem("apAlerts", "0");
    flash("alerts off");
  }
  updateAlertsUI();
}

function updateAlertsUI() {
  const granted = "Notification" in window && Notification.permission === "granted";
  const on = alertsOn && granted;
  const sa = $("setAlerts");
  if (sa) { sa.textContent = on ? "On" : "Off"; sa.classList.toggle("allow", on); }
}

function checkWaitingAlerts(sessions) {
  const waiting = (sessions || []).filter((s) => s.alive && s.status === "waiting");
  const nowIds = new Set(waiting.map((s) => s.sessionId));
  if (alertsOn && "Notification" in window && Notification.permission === "granted") {
    waiting.forEach((s) => {
      if (!knownWaiting.has(s.sessionId)) {
        const n = new Notification(`⏳ ${s.project || "agent"} is waiting`, {
          body: s.asking || s.lastPrompt || "waiting for your input",
          tag: s.sessionId,
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          selectedId = s.sessionId;
          if (lastState) {
            renderSessions(lastState.sessions, lastState.now);
            renderDetail(lastState.sessions, lastState.now);
          }
          showPage("sessions");
          document.querySelector(".grid")?.scrollIntoView({ behavior: "smooth" });
          n.close();
        };
      }
    });
  }
  knownWaiting = nowIds;
}

function updateUrgency(sessions) {
  const n = (sessions || []).filter((s) => s.alive && s.status === "waiting").length;
  document.body.classList.toggle("has-urgent", n > 0);
  document.title = n > 0 ? `(${n}) ⏳ waiting · rook` : "rook · local";
}

// dismissed sticky IDs for the current waiting episode
let dismissedStickies = new Set();

function renderStickies(sessions) {
  const el = $("stickies");
  if (!el) return;
  if (isTyping()) return; // don't wipe a reply box mid-type
  const waiting = (sessions || []).filter((s) => s.alive && s.status === "waiting");
  const waitingIds = new Set(waiting.map((s) => s.sessionId));
  // drop dismissals for agents that stopped waiting, so a new wait re-shows
  dismissedStickies.forEach((id) => {
    if (!waitingIds.has(id)) dismissedStickies.delete(id);
  });
  const show = waiting.filter((s) => !dismissedStickies.has(s.sessionId));
  el.innerHTML = show
    .map(
      (s) => `<div class="sticky" data-id="${s.sessionId}">
        <div class="sk-head">
          <span class="sk-siren"></span>
          <span class="sk-proj">${esc(s.project || "agent")} needs you</span>
          <button class="sk-x" data-dismiss="${s.sessionId}" title="dismiss">${icon("x")}</button>
        </div>
        <div class="sk-work sk-title">${esc(s.title || s.project || "session")}</div>
        <div class="sk-body">${esc(s.asking || s.lastPrompt || "waiting for your input")}</div>
        ${controlsHTML(s)}
      </div>`
    )
    .join("");
  // wire dismiss + jump-on-title + Allow/Deny/reply controls
  el.querySelectorAll("[data-dismiss]").forEach((b) =>
    b.addEventListener("click", () => {
      dismissedStickies.add(b.dataset.dismiss);
      renderStickies(lastState ? lastState.sessions : []);
    })
  );
  el.querySelectorAll(".sk-title").forEach((t) =>
    t.addEventListener("click", () => {
      const id = t.closest(".sticky")?.dataset.id;
      if (!id) return;
      selectedId = id;
      if (lastState) {
        renderSessions(lastState.sessions, lastState.now);
        renderDetail(lastState.sessions, lastState.now);
      }
      showPage("sessions");
      document.querySelector(".grid")?.scrollIntoView({ behavior: "smooth" });
    })
  );
  wireControls(el);
}

function render(st) {
  // Go marshals empty slices as null; normalize so a fresh install (no agents)
  // doesn't throw and break the whole dashboard.
  st.sessions = st.sessions || [];
  st.windows = st.windows || [];
  st.trends = st.trends || [];
  st.devServers = st.devServers || [];
  pumpBatch(); // spawn queued batch handoffs as worktree slots free up
  checkVersion(st);
  renderNotices(st);
  const now = st.now;
  checkWaitingAlerts(st.sessions);
  updateUrgency(st.sessions);
  renderStickies(st.sessions);
  // don't redraw the panels that hold the reply box while the user is typing
  if (!isTyping()) {
    renderDetail(st.sessions, now);
  }
  renderWindows(st.windows, now);
  renderUsage(st.sessions, st.windows);
  renderTrends(st.trends);
  renderSessions(st.sessions, now);
  renderHome(st.sessions, now);
  if (curPage === "board") renderBoard(st.sessions, now);
  renderEnv(st.env || {});
  renderAudit(st.sessions, now);
  renderDevServers(st.devServers);

  const active = st.sessions.filter((s) => s.alive).length;
  $("activeCount").textContent = `${active} active`;
  $("devCount").textContent = `${st.devServers.length}`;
  $("foot").textContent = `updated ${new Date(now).toLocaleTimeString()} · data from ~/.claude · localhost only`;
}

function renderAttention(sessions) {
  const waiting = (sessions || []).filter((s) => s.alive && s.status === "waiting");
  const el = $("attention");
  if (waiting.length === 0) {
    el.innerHTML = "";
    return;
  }
  const items = waiting
    .map(
      (s) => `<div class="aitem" data-id="${s.sessionId}">
        <div class="ajump" data-id="${s.sessionId}">
          <b>${esc(s.title || s.project || "session")}</b> · ${esc(s.project)}
          <span class="q">${esc(s.asking || s.lastPrompt || "waiting for your input")}</span>
        </div>
        ${controlsHTML(s)}
      </div>`
    )
    .join("");
  el.innerHTML = `<div class="acard urgent">
    <div class="ahead">
      <span class="utag">URGENT</span>
      <span class="siren"></span>
      ${waiting.length} agent${waiting.length > 1 ? "s" : ""} waiting for you
    </div>
    ${items}
  </div>`;
  el.querySelectorAll(".ajump").forEach((it) =>
    it.addEventListener("click", () => {
      selectedId = it.dataset.id;
      if (lastState) {
        renderSessions(lastState.sessions, lastState.now);
        renderDetail(lastState.sessions, lastState.now);
      }
      showPage("sessions");
      document.querySelector(".grid")?.scrollIntoView({ behavior: "smooth" });
    })
  );
  wireControls(el);
}

// controlsHTML renders Allow/Deny/menu/reply for a tmux-controllable session,
// or a hint to launch in tmux otherwise.
function controlsHTML(s) {
  if (!s.controllable) {
    return `<div class="ctl-hint muted">not in tmux — launch with <code>tmux new -s name claude</code> to answer from here</div>`;
  }
  return `<div class="ctl" data-id="${s.sessionId}">
    <button class="btn allow" data-act="allow">Allow <span class="k">a</span></button>
    <button class="btn danger" data-act="deny">Deny <span class="k">d</span></button>
    <button class="btn" data-act="key" data-val="2">opt 2</button>
    <button class="btn" data-act="key" data-val="3">opt 3</button>
    <input class="reply" data-id="${s.sessionId}" placeholder="type a reply, press Enter" />
  </div>`;
}

function wireControls(root) {
  root.querySelectorAll(".ctl").forEach((ctl) => {
    const id = ctl.dataset.id;
    ctl.querySelectorAll("button[data-act]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        respond(id, b.dataset.act, b.dataset.val || "");
      })
    );
    const input = ctl.querySelector(".reply");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
          respond(id, "text", input.value);
          input.value = "";
        }
        e.stopPropagation();
      });
    }
  });
}

async function respond(id, action, value) {
  try {
    const res = await fetch("/api/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, action, value: value || "" }),
    });
    if (!res.ok) flash(await apiErr(res), true);
    else flash(`sent ${action}${value ? " " + value : ""}`);
  } catch (e) {
    flash("send failed", true);
  }
  setTimeout(poll, 350);
}

// killSession stops a tmux-controlled agent (kills its pane) after confirmation.
async function killSession(id, label) {
  if (!confirm(`Stop the agent "${label || id}"? This kills its tmux pane and ends the agent.`)) return;
  try {
    const res = await fetch("/api/kill", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id }),
    });
    if (!res.ok) { flash(await apiErr(res), true); return; }
    flash("agent stopped");
  } catch (e) { flash("stop failed", true); }
  setTimeout(poll, 400);
}

// apiErr extracts a readable message from a response — GoFr wraps errors as
// {"error":{"message":"…"}}, so unwrap that; otherwise use the raw text.
async function apiErr(res) {
  const t = await res.text();
  try { const j = JSON.parse(t); return (j && j.error && j.error.message) || t; } catch (e) { return t; }
}

function flash(msg, bad) {
  const f = $("flash");
  if (!f) return;
  f.textContent = msg;
  f.className = "flash" + (bad ? " bad" : " ok");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => (f.className = "flash"), 2500);
}

function renderEnv(env) {
  const skills = env.skills || [];
  const plugins = env.plugins || [];
  const mcp = env.mcp || [];
  $("skillCount").textContent = `(${skills.length})`;
  $("pluginCount").textContent = `(${plugins.length})`;
  $("mcpCount").textContent = `(${mcp.length})`;

  $("skills").innerHTML =
    skills.map((s) => `<span class="chip">${esc(s.name)}</span>`).join("") ||
    `<span class="muted">none</span>`;

  $("plugins").innerHTML =
    plugins
      .map(
        (p) =>
          `<span class="chip ${p.state === "enabled" ? "on" : ""}">${esc(p.name.split("@")[0])}${
            p.detail ? `<span class="cv">${esc(p.detail)}</span>` : ""
          }</span>`
      )
      .join("") || `<span class="muted">none</span>`;

  $("mcp").innerHTML =
    mcp
      .map(
        (m) =>
          `<span class="chip ${m.state === "needs-auth" ? "auth" : "on"}">${esc(m.name)}${
            m.state === "needs-auth" ? '<span class="cv">auth</span>' : ""
          }</span>`
      )
      .join("") || `<span class="muted">none configured on disk</span>`;
}

function getLimit(label) {
  if (label === "5 hours") return parseFloat(localStorage.getItem("apLimit5h") || "0") || 0;
  if (label === "7 days") return parseFloat(localStorage.getItem("apLimit7d") || "0") || 0;
  return 0;
}

function setLimits() {
  const cur5 = (parseFloat(localStorage.getItem("apLimit5h") || "0") || 0) / 1e6;
  const cur7 = (parseFloat(localStorage.getItem("apLimit7d") || "0") || 0) / 1e6;
  const a = prompt("5-hour token limit, in MILLIONS (blank = clear):", cur5 || "");
  if (a !== null) {
    const v = parseFloat(a);
    if (v > 0) localStorage.setItem("apLimit5h", String(v * 1e6));
    else localStorage.removeItem("apLimit5h");
  }
  const b = prompt("Weekly token limit, in MILLIONS (blank = clear):", cur7 || "");
  if (b !== null) {
    const v = parseFloat(b);
    if (v > 0) localStorage.setItem("apLimit7d", String(v * 1e6));
    else localStorage.removeItem("apLimit7d");
  }
  if (lastState) { renderWindows(lastState.windows, lastState.now); renderUsage(lastState.sessions, lastState.windows); }
}

function renderWindows(wins, now) {
  $("windows").innerHTML = (wins || [])
    .map((w) => {
      const freesIn =
        w.firstMs && w.windowMs ? Math.max(0, w.firstMs + w.windowMs - now) : 0;
      const limit = getLimit(w.label);
      let bar = "";
      if (limit > 0) {
        const pct = Math.min(100, (w.total / limit) * 100);
        const left = Math.max(0, limit - w.total);
        const danger = pct >= 90 ? " danger" : pct >= 70 ? " warn" : "";
        bar = `<div class="ubar${danger}"><div class="ufill" style="width:${pct}%"></div></div>
          <div class="uline"><b>${pct.toFixed(0)}% used</b> · ${fmtTokens(left)} left of ${fmtTokens(limit)}</div>`;
      }
      return `<div class="wcard">
        <div class="wcard-head">
          <span class="wlabel">Last ${w.label}</span>
          <span class="wmsgs">${(w.messages || 0).toLocaleString()} messages</span>
        </div>
        <div class="wtotal">${fmtTokens(w.total)}<span class="wunit">tokens</span></div>
        ${bar}
        <div class="wstats">
          <div class="wstat"><span>Input</span><b>${fmtTokens(w.input)}</b></div>
          <div class="wstat"><span>Output</span><b>${fmtTokens(w.output)}</b></div>
          <div class="wstat"><span>Cache</span><b>${fmtTokens(w.cacheRead + w.cacheWrite)}</b></div>
          <div class="wstat" title="when the oldest counted usage rolls out of this window"><span>Frees in</span><b>${freesIn ? fmtDur(freesIn) : "—"}</b></div>
        </div>
      </div>`;
    })
    .join("");
}

let usageWin = "tokens7d"; // tokens5h | tokens7d
let usageGroup = "agent"; // agent | project

function initUsageToggle() {
  document.querySelectorAll("[data-uwin]").forEach((b) =>
    b.addEventListener("click", () => {
      usageWin = b.dataset.uwin;
      document.querySelectorAll("[data-uwin]").forEach((x) => x.classList.toggle("on", x === b));
      if (lastState) renderUsage(lastState.sessions, lastState.windows);
    })
  );
  document.querySelectorAll("[data-ugroup]").forEach((b) =>
    b.addEventListener("click", () => {
      usageGroup = b.dataset.ugroup;
      document.querySelectorAll("[data-ugroup]").forEach((x) => x.classList.toggle("on", x === b));
      $("usageTitle").textContent = "Usage by " + usageGroup;
      if (lastState) renderUsage(lastState.sessions, lastState.windows);
    })
  );
}

// renderCostBreakdown fills the Usage-page cost panel from /api/usage (typed
// windows + per-model + per-run cost, Langfuse-style).
async function renderCostBreakdown() {
  const el = $("costBreakdown");
  if (!el) return;
  let d;
  try { d = await (await fetch("/api/usage", { cache: "no-store" })).json(); }
  catch (e) { el.innerHTML = `<p class="gherr">couldn't load cost breakdown</p>`; return; }
  const models = d.models || [], runs = d.runs || [];
  if ($("costTotal")) $("costTotal").textContent = `${fmtTokens(d.tokensTotal || 0)} tokens · ${fmtUSD(d.costUsd || 0)} est`;
  if (!models.length) { el.innerHTML = `<p class="empty">No usage yet.</p>`; return; }
  const usd = (v) => fmtUSD(v || 0);
  const maxCost = Math.max(...models.map((m) => m.costUsd || 0), 0.0001);
  el.innerHTML = `
    <div class="cost-viz">
      <div class="cost-share">
        <div class="cost-sub">Share</div>
        <div id="costDonut"></div>
      </div>
      <div class="cost-models">
        <div class="cost-sub">Cost by model</div>
        ${models.map((m) => `
          <div class="cost-row">
            <span class="cost-name">${esc(shortModel(m.model) || m.model || "—")}</span>
            <span class="cost-bar"><span class="cost-bar-fill" style="width:${Math.round(((m.costUsd || 0) / maxCost) * 100)}%"></span></span>
            <span class="cost-tok muted">${fmtTokens(m.tokensTotal)}</span>
            <span class="cost-usd">${usd(m.costUsd)}</span>
          </div>`).join("")}
      </div>
    </div>
    <div class="cost-runs">
      <div class="cost-sub">Top runs by cost</div>
      ${runs.slice(0, 12).map((r) => `
        <div class="cost-run">
          <span class="cost-run-title">${esc(r.title || r.project || r.sessionId)}</span>
          <span class="cost-run-model muted mono">${esc(shortModel(r.model) || "")}</span>
          <span class="cost-tok muted">${fmtTokens(r.tokensTotal)}</span>
          <span class="cost-usd">${usd(r.costUsd)}</span>
        </div>`).join("")}
    </div>`;
  const rc = window.rookCharts;
  if (rc) {
    rc.donut($("costDonut"), {
      slices: models.map((m) => ({ label: shortModel(m.model) || m.model || "—", value: m.costUsd || 0 })),
      format: usd,
    });
  }
}

function renderUsage(sessions, windows) {
  const el = $("usage");
  if (!el) return;
  const key = usageWin;
  const winTotal =
    ((windows || []).find((w) => w.label === (key === "tokens5h" ? "5 hours" : "7 days")) || {}).total || 0;

  if (usageGroup === "project") {
    // aggregate token usage by project
    const byProj = {};
    (sessions || []).forEach((s) => {
      const v = s[key] || 0;
      if (v <= 0) return;
      const p = s.project || "—";
      byProj[p] = (byProj[p] || 0) + v;
    });
    const rows = Object.entries(byProj).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!rows.length) { el.innerHTML = `<p class="empty">No project usage in this window.</p>`; return; }
    const peak = rows[0][1] || 1;
    el.innerHTML = rows.map(([proj, v]) => {
      const barPct = Math.max(3, Math.round((v / peak) * 100));
      const share = winTotal ? Math.round((v / winTotal) * 100) : 0;
      return `<div class="ua-row"><div class="ua-name"><span class="sdot s-idle"></span><span class="ua-label"><span class="ua-proj">${esc(proj)}</span></span></div>
        <div class="ua-track"><div class="ua-fill" style="width:${barPct}%"></div></div>
        <div class="ua-val">${fmtTokens(v)}<span class="ua-pct">${share}%</span></div></div>`;
    }).join("");
    return;
  }

  const agents = (sessions || [])
    .filter((s) => (s[key] || 0) > 0)
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))
    .slice(0, 12);
  if (agents.length === 0) {
    el.innerHTML = `<p class="empty">No agent usage in this window.</p>`;
    return;
  }
  const peak = agents[0][key] || 1; // bar scaled to the busiest agent
  const rows = agents
    .map((s) => {
      const v = s[key] || 0;
      const barPct = Math.max(3, Math.round((v / peak) * 100));
      const share = winTotal ? Math.round((v / winTotal) * 100) : 0;
      const label = s.title && s.title !== s.project ? s.title : "";
      return `<div class="ua-row" data-id="${s.sessionId}" title="${esc(s.project || "session")}${label ? " · " + esc(label) : ""}">
        <div class="ua-name"><span class="sdot s-${statusOf(s)}"></span><span class="ua-label"><span class="ua-proj">${esc(s.project || "session")}</span>${label ? `<span class="ua-title">${esc(label)}</span>` : ""}</span></div>
        <div class="ua-track"><div class="ua-fill" style="width:${barPct}%"></div></div>
        <div class="ua-val">${fmtTokens(v)}<span class="ua-pct">${share}%</span></div>
      </div>`;
    })
    .join("");
  el.innerHTML = rows;
  el.querySelectorAll(".ua-row").forEach((r) =>
    r.addEventListener("click", () => {
      selectedId = r.dataset.id;
      if (lastState) { renderSessions(lastState.sessions, lastState.now); renderDetail(lastState.sessions, lastState.now); }
      showPage("sessions");
      document.querySelector(".grid")?.scrollIntoView({ behavior: "smooth" });
    })
  );
}

// renderTrace draws a Langfuse-style waterfall of a session's tool calls into
// #traceMount. toolCalls carry only a timestamp + name, so each span's duration
// is the gap until the next call (the last span gets the median gap) — this
// surfaces stalls between actions, not model-reported latency.
function renderTrace(s) {
  const mount = $("traceMount");
  const rc = window.rookCharts;
  if (!mount || !rc) return;
  const calls = (s.toolCalls || [])
    .map((t) => ({ name: t.name, summary: t.summary, ts: new Date(t.timestamp).getTime() }))
    .filter((c) => !isNaN(c.ts))
    .sort((a, b) => a.ts - b.ts);
  if (calls.length < 2) return;
  const t0 = calls[0].ts;
  const gaps = [];
  for (let i = 0; i < calls.length - 1; i++) gaps.push(calls[i + 1].ts - calls[i].ts);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1000;
  const spans = calls.map((c, i) => ({
    name: c.summary ? `${c.name} · ${c.summary}`.slice(0, 60) : c.name,
    type: c.name,
    startMs: c.ts - t0,
    durMs: i < calls.length - 1 ? calls[i + 1].ts - c.ts : median,
    depth: 0,
  }));
  rc.traceTimeline(mount, { spans });
}

let trendMetric = "messages";

function initTrendControls() {
  document.querySelectorAll(".tm-btn").forEach((b) =>
    b.addEventListener("click", () => {
      trendMetric = b.dataset.metric;
      document.querySelectorAll(".tm-btn").forEach((x) => x.classList.toggle("on", x === b));
      if (lastState) renderTrends(lastState.trends);
    })
  );
}

function renderTrends(trends) {
  const el = $("trend");
  if (!el) return;
  const days = trends || [];
  if (days.length === 0) {
    el.innerHTML = `<p class="empty">No activity data.</p>`;
    return;
  }
  const key = trendMetric;
  const max = Math.max(...days.map((d) => d[key] || 0), 1);
  const fmtVal = (v) => (key === "tokens" ? fmtTokens(v) : Math.round(v).toLocaleString());
  const total = days.reduce((a, d) => a + (d[key] || 0), 0);
  const avg = Math.round(total / days.length);
  el.innerHTML = `
    <div id="trendChart"></div>
    <div class="tfoot">
      <span><i class="tdot"></i> ${fmtVal(total)} total</span>
      <span><i class="tdot peak"></i> ${fmtVal(max)} peak</span>
      <span><i class="tdot avg"></i> ${fmtVal(avg)} avg/day</span>
    </div>`;
  const rc = window.rookCharts;
  if (rc) {
    rc.lineArea($("trendChart"), {
      points: days.map((d) => ({
        label: new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        value: d[key] || 0,
      })),
      format: fmtVal,
    });
  }
}

// ---- fast custom tooltip (instant, no native title delay) ----
function tipEl() {
  let t = $("tip");
  if (!t) {
    t = document.createElement("div");
    t.id = "tip";
    t.className = "tip";
    document.body.appendChild(t);
  }
  return t;
}

function wireTip(root) {
  if (!root) return;
  const t = tipEl();
  root.addEventListener("mousemove", (e) => {
    const col = e.target.closest("[data-tip]");
    if (!col) { t.classList.remove("show"); return; }
    t.textContent = col.dataset.tip;
    t.classList.add("show");
    const pad = 12;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = t.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    t.style.left = x + "px";
    t.style.top = y + "px";
  });
  root.addEventListener("mouseleave", () => t.classList.remove("show"));
}

function statusOf(s) {
  return s.alive ? (s.status || "idle") : "dead";
}

// provBadge renders the agent provider chip; non-Claude adapters are marked beta.
function provBadge(p) {
  p = p || "claude";
  const beta = p !== "claude";
  return `<span class="prov prov-${esc(p)}"${beta ? ' title="beta — detection unverified against real data"' : ""}>${esc(p)}${beta ? " β" : ""}</span>`;
}

function fmtUSD(n) {
  if (!n) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 100) return "$" + n.toFixed(2);
  return "$" + Math.round(n).toLocaleString();
}

function initFilters() {
  ["sSearch", "sStatus", "sSort", "sHideDead"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const evt = id === "sSearch" ? "input" : "change";
    el.addEventListener(evt, () => {
      if (lastState) renderSessions(lastState.sessions, lastState.now);
    });
  });
  const all = $("devAll");
  if (all) {
    all.addEventListener("change", () => {
      if (all.checked) devServersCache.forEach((d) => selectedPorts.add(d.port));
      else selectedPorts.clear();
      if (lastState) renderDevServers(lastState.devServers);
    });
  }
}

function applyFilters(sessions) {
  const q = ($("sSearch")?.value || "").toLowerCase().trim();
  const status = $("sStatus")?.value || "all";
  const sort = $("sSort")?.value || "recent";
  const hideDead = $("sHideDead")?.checked;

  let list = (sessions || []).filter((s) => {
    const st = statusOf(s);
    if (hideDead && st === "dead") return false;
    if (status === "active" && !s.alive) return false;
    if (["waiting", "busy", "idle"].includes(status) && st !== status) return false;
    if (q) {
      const hay = `${s.title} ${s.project} ${s.cwd} ${s.activity} ${s.lastPrompt}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const rank = { busy: 0, waiting: 1, shell: 2, idle: 3, dead: 4 };
  list.sort((a, b) => {
    if (sort === "tokens") return (b.tokensTotal || 0) - (a.tokensTotal || 0);
    if (sort === "cost") return (b.costUsd || 0) - (a.costUsd || 0);
    if (sort === "project") return (a.project || "").localeCompare(b.project || "");
    // recent: alive first, then by updatedAt
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const ra = rank[statusOf(a)] ?? 9, rb = rank[statusOf(b)] ?? 9;
    if (ra !== rb) return ra - rb;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return list;
}

// healthChip renders the watchdog badge for a session (nothing when healthy).
function healthChip(s) {
  if (!s || !s.health) return "";
  const glyph = s.health.level === "alert" ? "⚠" : "●";
  return ` <span class="hchip h-${s.health.level}" title="${esc(s.health.reason)}">${glyph} ${esc(s.health.reason)}</span>`;
}

function renderSessions(sessions, now) {
  const el = $("sessions");
  const list = applyFilters(sessions);
  $("sessionCount").textContent = `${list.length} / ${(sessions || []).length}`;
  if (list.length === 0) {
    el.innerHTML = `<p class="empty">No sessions match.</p>`;
    return;
  }
  el.innerHTML = list
    .map((s) => {
      const st = statusOf(s);
      const sel = s.sessionId === selectedId ? " sel" : "";
      const sub =
        (st === "busy" || st === "shell") && s.activity
          ? s.activity
          : s.lastPrompt || s.cwd || "";
      return `<li class="srow${sel}" data-id="${s.sessionId}">
        <span class="sdot s-${st}"></span>
        <span style="min-width:0">
          <div class="stitle">${esc(s.title || s.project || "session")}${healthChip(s)}</div>
          <div class="smeta">${provBadge(s.provider)}<span class="hrow-proj">${esc(s.project)}</span> <span class="badge b-${st}">${st}</span> · ${ago(s.updatedAt, now)}</div>
          <div class="smeta smeta-sub">${esc(sub)}</div>
        </span>
        <span class="stok">${fmtTokens(s.tokens7d || s.tokensTotal)}<br/><span class="scost" title="tokens used in the last 7 days">7d</span></span>
      </li>`;
    })
    .join("");
  el.querySelectorAll(".srow").forEach((row) => {
    row.addEventListener("click", () => {
      selectedId = row.dataset.id;
      renderSessions(sessions, now);
      renderDetail(sessions, now);
    });
  });
}

// sessionPRCache[sessionId] = { pr, ts }. Found PRs cache forever; "no PR yet"
// re-checks every 20s so a PR opened mid-session shows up.
const sessionPRCache = {};
function maybeFetchSessionPR(s) {
  if (!s.cwd) return;
  const c = sessionPRCache[s.sessionId];
  if (c && (c.pr || Date.now() - c.ts < 20000)) return;
  sessionPRCache[s.sessionId] = { pr: c ? c.pr : null, ts: Date.now() };
  fetch("/api/session-pr?cwd=" + encodeURIComponent(s.cwd), { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      sessionPRCache[s.sessionId] = { pr: d.pr || null, ts: Date.now() };
      if (selectedId === s.sessionId && lastState) renderDetail(lastState.sessions, lastState.now);
    })
    .catch(() => {});
}

function renderDetail(sessions, now) {
  const el = $("detail");
  let s = sessions.find((x) => x.sessionId === selectedId);
  if (!s && sessions.length) {
    s = sessions[0];
    selectedId = s.sessionId;
  }
  if (!s) {
    el.innerHTML = `<p class="empty">No session selected.</p>`;
    $("detailTitle").textContent = "";
    return;
  }
  const st = statusOf(s);
  $("detailTitle").textContent = s.title || s.project || "";
  const tools = (s.toolCalls || [])
    .map(
      (t) => `<div class="tool">
        <span class="ttime">${new Date(t.timestamp).toLocaleTimeString()}</span>
        <span class="tname">${esc(t.name)}</span>
        <span class="tsum">${esc(t.summary)}</span>
      </div>`
    )
    .join("");
  const asking =
    st === "waiting"
      ? `<div class="asking"><div class="alabel">waiting — last message</div><div class="atext">${esc(
          s.asking || s.lastPrompt || "(no message captured)"
        )}</div>${controlsHTML(s)}</div>`
      : "";
  const skillsLine =
    s.skills && s.skills.length
      ? `<div class="skills-line">project skills: ${s.skills.map(esc).join(", ")}</div>`
      : "";
  const activity =
    st !== "waiting" && s.activity
      ? `<div class="activity"><span class="adot s-${st}"></span>${esc(s.activity)}</div>`
      : "";
  const worksum = s.summary
    ? `<div class="worksum"><span class="wslabel">Work done</span> ${esc(s.summary)}</div>`
    : "";
  const changed =
    s.changedFiles && s.changedFiles.length
      ? `<div class="changed">
          <div class="clabel">Files changed (${s.changedFiles.length})</div>
          <div class="cfiles">${s.changedFiles
            .map(
              (f) =>
                `<span class="cfile" title="${esc(f)}">${esc(f.split("/").pop())}</span>`
            )
            .join("")}</div>
        </div>`
      : "";
  const ghRef = githubRefFromSession(s);
  maybeFetchSessionPR(s);
  const openedPR = (sessionPRCache[s.sessionId] || {}).pr;
  const prBtn = openedPR
    ? `<button class="btn ghworkbtn" id="openedPRBtn" title="This agent opened PR #${openedPR.number} (${esc((openedPR.state || "").toLowerCase())})">${icon("check")} PR #${openedPR.number}</button>`
    : "";
  el.innerHTML = `
    <div class="dhead">
      <div class="dtitle">${esc(s.title || s.project || "session")}${healthChip(s)}</div>
      <span style="display:flex;gap:6px">
        ${prBtn}
        ${ghRef ? `<button class="btn" id="ghRefBtn" title="Open ${ghRef.kind === "pr" ? "PR" : "issue"} #${ghRef.number} on GitHub">${icon("external")} #${ghRef.number}</button>` : ""}
        ${s.cwd ? `<button class="btn" id="diffBtn" title="Review this agent's changes (git diff)">${icon("diff")} Diff</button>` : ""}
        ${s.controllable ? `<button class="btn" id="termBtn">${icon("terminal")} Terminal</button>` : ""}
        <button class="btn ghost" id="logsBtn">${icon("external")} Logs</button>
        ${s.controllable && s.alive ? `<button class="btn danger" id="killBtn" title="Stop this agent (kills its tmux pane)">${icon("stop")} Stop</button>` : ""}
      </span>
    </div>
    ${activity}
    ${worksum}
    ${asking}
    <div class="dgrid">
      <span class="k">agent</span><span class="v">${provBadge(s.provider)}</span>
      <span class="k">status</span><span class="v"><span class="badge b-${st}">${st}</span></span>
      <span class="k">project</span><span class="v">${esc(s.project)}</span>
      <span class="k">cwd</span><span class="v mono copyable" data-copy="${esc(s.cwd)}" title="click to copy">${esc(s.cwd)}</span>
      <span class="k">model</span><span class="v">${esc(shortModel(s.model)) || "—"}</span>
      <span class="k">pid</span><span class="v mono">${s.pid}${s.alive ? "" : " (exited)"}</span>
      <span class="k">version</span><span class="v mono">${esc(s.version)}</span>
      <span class="k">tokens</span><span class="v">${fmtTokens(s.tokensTotal)} total</span>
      <span class="k">usage</span><span class="v">last 5h: <b>${fmtTokens(s.tokens5h)}</b> · last 7d: <b>${fmtTokens(s.tokens7d)}</b></span>
      <span class="k">cost (est)</span><span class="v" title="estimated from token usage at public list prices">${fmtUSD(s.costUsd)}</span>
      <span class="k">updated</span><span class="v">${ago(s.updatedAt, now)}</span>
    </div>
    ${skillsLine}
    ${changed}
    ${(s.toolCalls || []).length > 1 ? `<div class="tlabel">Trace</div><div id="traceMount" class="trace-mount"></div>` : ""}
    <div class="tlabel">Activity log</div>
    ${tools ? tools : '<p class="empty">No tool calls recorded.</p>'}
  `;
  renderTrace(s);
  const lb = $("logsBtn");
  if (lb) lb.addEventListener("click", () => window.open(`/api/logs?session=${encodeURIComponent(s.sessionId)}`, "_blank"));
  const tb = $("termBtn");
  if (tb) tb.addEventListener("click", () => openTerm(s.sessionId, s.tmuxPane, s.title || s.project));
  const db = $("diffBtn");
  if (db) db.addEventListener("click", () => openDiff(s.cwd, s.title || s.project || "session", s.tmuxPane));
  const gb = $("ghRefBtn");
  if (gb && ghRef) gb.addEventListener("click", () => window.open(ghRef.url, "_blank"));
  const pb = $("openedPRBtn");
  if (pb && openedPR) pb.addEventListener("click", () => window.open(openedPR.url, "_blank"));
  const kb = $("killBtn");
  if (kb) kb.addEventListener("click", () => killSession(s.sessionId, s.title || s.project));
  el.querySelectorAll(".copyable").forEach((c) =>
    c.addEventListener("click", () => {
      navigator.clipboard?.writeText(c.dataset.copy);
      flash("copied to clipboard");
    })
  );
  wireControls(el);
}

// keyboard shortcuts: a=allow, d=deny, 1-3=menu, on the selected waiting
// controllable session (ignored while typing in the reply box or any input).
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (document.activeElement?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") {
    if (e.key === "Escape") document.activeElement.blur();
    return;
  }
  // "/" focuses the session search from anywhere
  if (e.key === "/") {
    showPage("sessions"); location.hash = "sessions";
    const sb = $("sSearch");
    if (sb) { sb.focus(); e.preventDefault(); }
    return;
  }
  if (!lastState) return;
  const s = (lastState.sessions || []).find((x) => x.sessionId === selectedId);
  if (!s || !s.controllable || !(s.alive && s.status === "waiting")) return;
  if (e.key === "a") respond(s.sessionId, "allow");
  else if (e.key === "d") respond(s.sessionId, "deny");
  else if (e.key >= "1" && e.key <= "9") respond(s.sessionId, "key", e.key);
  else return;
  e.preventDefault();
});

// selected dev-server ports (persists across polls)
let selectedPorts = new Set();
let devServersCache = [];

let auditMode = "live";
function auditRowHTML(ts, provider, project, summary) {
  return `<div class="auditrow">
    <span class="ttime">${ts ? new Date(ts).toLocaleTimeString() : "—"}</span>
    ${provBadge(provider)}
    <span class="muted">${esc(project)}</span>
    <span class="mono aud-cmd">${esc(summary)}</span>
  </div>`;
}

// renderAuditHistory pulls the persisted command history from SQLite.
async function renderAuditHistory() {
  const q = ($("auditSearch")?.value || "").trim();
  try {
    const rows = await (await fetch("/api/audit-history" + (q ? "?q=" + encodeURIComponent(q) : ""), { cache: "no-store" })).json();
    $("auditCmdCount").textContent = `${rows.length}${rows.length === 500 ? "+" : ""} stored`;
    $("auditCmds").innerHTML = rows.length
      ? rows.map((c) => auditRowHTML(c.ts, c.provider, c.project, c.cmd)).join("")
      : `<p class="empty">No commands in history yet.</p>`;
  } catch (e) { $("auditCmds").innerHTML = `<p class="gherr">couldn't load history</p>`; }
}

function initAuditToggle() {
  document.querySelectorAll("#auditToggle .tm-btn").forEach((b) =>
    b.addEventListener("click", () => {
      auditMode = b.dataset.audit;
      document.querySelectorAll("#auditToggle .tm-btn").forEach((x) => x.classList.toggle("on", x === b));
      $("auditSearch").hidden = auditMode !== "history";
      if (auditMode === "history") renderAuditHistory();
      else if (lastState) renderAudit(lastState.sessions, lastState.now);
    })
  );
  $("auditSearch")?.addEventListener("input", () => { if (auditMode === "history") renderAuditHistory(); });
}

const wtChecked = new Set(); // worktree paths checked for bulk removal

// renderWorktrees lists agent worktrees under ~/.rook/worktrees with prune.
async function renderWorktrees() {
  const el = $("worktrees");
  if (!el) return;
  try {
    const wts = await (await fetch("/api/worktrees", { cache: "no-store" })).json();
    $("wtCount").textContent = wts.length ? `${wts.length}` : "";
    // drop selections for worktrees that no longer exist or are now in use
    const removable = new Set(wts.filter((w) => !w.inUse).map((w) => w.path));
    [...wtChecked].forEach((p) => { if (!removable.has(p)) wtChecked.delete(p); });
    if (!wts.length) { el.innerHTML = `<p class="empty">No agent worktrees. Review/work handoffs create isolated worktrees here.</p>`; renderWtBulk(); return; }
    el.innerHTML = wts.map((w) => `<div class="wtrow${wtChecked.has(w.path) ? " checked" : ""}">
      ${w.inUse ? '<span class="wt-cb-gap"></span>' : `<input type="checkbox" class="sum-cb wt-cb" data-wtpath="${esc(w.path)}"${wtChecked.has(w.path) ? " checked" : ""} title="select for bulk remove" />`}
      <div class="wt-main">
        <div class="wt-name">${esc(w.name)} ${w.inUse ? '<span class="badge b-busy">in use</span>' : ""}</div>
        <div class="wt-meta muted mono">${esc(w.repo || "")}${w.branch ? " · " + esc(w.branch) : ""} · ${esc(w.path)}</div>
      </div>
      <button class="btn" data-wtdiff="${esc(w.path)}" data-wtname="${esc(w.name)}" title="Review this worktree's changes">Diff</button>
      <button class="btn danger" data-wtremove="${esc(w.path)}"${w.inUse ? " disabled title=\"stop the agent first\"" : ""}>Remove</button>
    </div>`).join("");
    el.querySelectorAll("[data-wtdiff]").forEach((b) =>
      b.addEventListener("click", () => openDiff(b.dataset.wtdiff, b.dataset.wtname)));
    el.querySelectorAll(".wt-cb").forEach((cb) =>
      cb.addEventListener("change", () => {
        const p = cb.dataset.wtpath;
        if (cb.checked) wtChecked.add(p); else wtChecked.delete(p);
        cb.closest(".wtrow").classList.toggle("checked", cb.checked);
        renderWtBulk();
      })
    );
    el.querySelectorAll("[data-wtremove]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Remove this worktree?\n" + b.dataset.wtremove)) return;
        await fetch("/api/worktrees?path=" + encodeURIComponent(b.dataset.wtremove), { method: "DELETE" });
        flash("worktree removed");
        renderWorktrees();
      })
    );
    renderWtBulk();
  } catch (e) { el.innerHTML = `<p class="gherr">couldn't load worktrees</p>`; }
}

// renderWtBulk shows the bulk-remove bar when worktrees are checked.
function renderWtBulk() {
  const bar = $("wtBulk");
  if (!bar) return;
  const n = wtChecked.size;
  if (!n) { bar.innerHTML = ""; return; }
  bar.innerHTML = `<span class="bulk-n">${n} selected</span>
    <button class="btn danger" id="wtBulkDel">Remove ${n}</button>
    <button class="btn ghost" id="wtBulkClear">Clear</button>`;
  $("wtBulkDel").addEventListener("click", deleteSelectedWorktrees);
  $("wtBulkClear").addEventListener("click", () => { wtChecked.clear(); renderWorktrees(); });
}

let wtBulkBusy = false;
async function deleteSelectedWorktrees() {
  if (wtBulkBusy) return; // guard against a double-click re-firing the batch
  const paths = [...wtChecked];
  if (!paths.length) return;
  if (!confirm(`Remove ${paths.length} worktree${paths.length === 1 ? "" : "s"}? This can't be undone.`)) return;
  wtBulkBusy = true;
  const btn = $("wtBulkDel");
  if (btn) { btn.disabled = true; btn.textContent = "Removing…"; }
  let ok = 0;
  for (const p of paths) {
    try {
      const res = await fetch("/api/worktrees?path=" + encodeURIComponent(p), { method: "DELETE" });
      if (res.ok) ok++;
    } catch (e) {}
  }
  wtChecked.clear();
  wtBulkBusy = false;
  flash(`removed ${ok} worktree${ok === 1 ? "" : "s"}`, ok < paths.length);
  renderWorktrees();
}

function renderAudit(sessions, now) {
  const cmdsEl = $("auditCmds"), filesEl = $("auditFiles");
  if (!cmdsEl || !filesEl) return;
  const sl = sessions || [];

  // commands: live Bash/Shell tool calls across agents (history mode is fetched
  // separately and not overwritten by polling)
  if (auditMode === "live") {
    const cmds = [];
    sl.forEach((s) => {
      (s.toolCalls || []).forEach((t) => {
        if (t.name === "Bash" || t.name === "Shell") {
          cmds.push({ ...t, project: s.project, provider: s.provider || "claude" });
        }
      });
    });
    cmds.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    $("auditCmdCount").textContent = `${cmds.length}`;
    cmdsEl.innerHTML =
      cmds.slice(0, 150).map((c) => auditRowHTML(c.timestamp, c.provider, c.project, c.summary)).join("")
      || `<p class="empty">No commands recorded.</p>`;
  }

  // files: changed files grouped by session
  let fileTotal = 0;
  const groups = sl
    .filter((s) => (s.changedFiles || []).length)
    .map((s) => {
      fileTotal += s.changedFiles.length;
      return `<div class="auditfg">
        <div class="auditfg-head">${provBadge(s.provider)}
          <b>${esc(s.project || "session")}</b> <span class="muted">· ${s.changedFiles.length} files</span></div>
        <div class="cfiles">${s.changedFiles.slice(0, 40).map((f) => `<span class="cfile" title="${esc(f)}">${esc(f.split("/").pop())}</span>`).join("")}</div>
      </div>`;
    });
  $("auditFileCount").textContent = `${fileTotal}`;
  filesEl.innerHTML = groups.join("") || `<p class="empty">No file changes recorded.</p>`;
}

function renderDevServers(servers) {
  devServersCache = servers || [];
  const el = $("devservers");
  if (devServersCache.length === 0) {
    selectedPorts.clear();
    el.innerHTML = `<tr><td colspan="7" class="muted" style="padding:14px 16px">No listening dev servers detected.</td></tr>`;
    renderBulkBar();
    return;
  }
  // prune selections for ports that disappeared
  const live = new Set(devServersCache.map((d) => d.port));
  selectedPorts.forEach((p) => { if (!live.has(p)) selectedPorts.delete(p); });

  el.innerHTML = devServersCache
    .map(
      (d) => `<tr class="${selectedPorts.has(d.port) ? "row-sel" : ""}">
        <td class="cbcol"><input type="checkbox" class="devcb" data-port="${d.port}" data-pid="${d.pid}" ${selectedPorts.has(d.port) ? "checked" : ""} /></td>
        <td class="port">${d.port}</td>
        <td class="mono">${esc(d.command)}</td>
        <td>${d.runtime ? `<span class="rt">${esc(d.runtime)}</span>` : '<span class="muted">—</span>'}</td>
        <td>${esc(d.project) || '<span class="muted">—</span>'}</td>
        <td class="mono muted">${d.pid}</td>
        <td style="text-align:right; white-space:nowrap">
          <button class="btn" data-open="http://localhost:${d.port}">Open</button>
          <button class="btn" data-copy="http://localhost:${d.port}">Copy</button>
          <button class="btn danger" data-stop="${d.pid}">Stop</button>
        </td>
      </tr>`
    )
    .join("");
  el.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => window.open(b.dataset.open, "_blank"))
  );
  el.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => navigator.clipboard?.writeText(b.dataset.copy))
  );
  el.querySelectorAll("[data-stop]").forEach((b) =>
    b.addEventListener("click", () => stopServer(parseInt(b.dataset.stop, 10), b))
  );
  el.querySelectorAll(".devcb").forEach((cb) =>
    cb.addEventListener("change", () => {
      const port = parseInt(cb.dataset.port, 10);
      if (cb.checked) selectedPorts.add(port);
      else selectedPorts.delete(port);
      cb.closest("tr").classList.toggle("row-sel", cb.checked);
      renderBulkBar();
    })
  );
  syncSelectAll();
  renderBulkBar();
}

function syncSelectAll() {
  const all = $("devAll");
  if (!all) return;
  const total = devServersCache.length;
  const sel = selectedPorts.size;
  all.checked = total > 0 && sel === total;
  all.indeterminate = sel > 0 && sel < total;
}

function renderBulkBar() {
  const bar = $("devBulk");
  if (!bar) return;
  const n = selectedPorts.size;
  if (n === 0) { bar.innerHTML = ""; return; }
  const pids = new Set(
    devServersCache.filter((d) => selectedPorts.has(d.port)).map((d) => d.pid)
  );
  bar.innerHTML = `<span class="bulk-n">${n} selected</span>
    <button class="btn danger" id="bulkStop">Stop ${pids.size} process${pids.size > 1 ? "es" : ""}</button>
    <button class="btn ghost" id="bulkClear">Clear</button>`;
  $("bulkStop").addEventListener("click", stopSelected);
  $("bulkClear").addEventListener("click", () => {
    selectedPorts.clear();
    if (lastState) renderDevServers(lastState.devServers);
  });
}

async function stopSelected() {
  const pids = [...new Set(
    devServersCache.filter((d) => selectedPorts.has(d.port)).map((d) => d.pid)
  )];
  if (pids.length === 0) return;
  if (!confirm(`Send SIGTERM to ${pids.length} process(es)? (ports: ${[...selectedPorts].sort((a,b)=>a-b).join(", ")})`)) return;
  let ok = 0;
  for (const pid of pids) {
    try {
      const res = await fetch("/api/devserver/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      });
      if (res.ok) ok++;
    } catch (e) {}
  }
  flash(`stopped ${ok}/${pids.length} process${pids.length > 1 ? "es" : ""}`, ok < pids.length);
  selectedPorts.clear();
  setTimeout(poll, 400);
}

async function stopServer(pid, btn) {
  if (!confirm(`Send SIGTERM to PID ${pid}?`)) return;
  btn.textContent = "…";
  try {
    await fetch("/api/devserver/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid }),
    });
  } finally {
    poll();
  }
}

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString();
  if (lastOk && Date.now() - lastOk > POLL_MS * 3) {
    $("connDot").classList.add("stale");
  }
}

document.body.classList.add("booting");
initTabs();
initLogos();
initGitHub();
// Register the PWA service worker (progressive enhancement; no-op if unsupported).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("SW registration failed:", err));
  });
}

initSpawn();
initLaunch();
initDiff();
initHooks();
initBoard();
initHome();
initSummary();
initAuditToggle();
initPalette();
$("wtRefresh")?.addEventListener("click", renderWorktrees);
initUsageToggle();
initTerm();
initModals();
initTheme();
initFilters();
initTrendControls();
$("limitBtn")?.addEventListener("click", setLimits);
$("usageLink")?.addEventListener("click", () => {
  const w = 980, h = 820;
  const left = Math.max(0, Math.round((screen.width - w) / 2));
  const top = Math.max(0, Math.round((screen.height - h) / 2));
  window.open(
    "https://claude.ai/settings/usage",
    "rookUsage",
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`
  );
});
poll();
setInterval(poll, POLL_MS);
setInterval(tickClock, 1000);
tickClock();
