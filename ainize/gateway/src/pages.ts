const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(title: string, body: string, extraHead = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AinCode</title>${extraHead}
<style>
:root{--bg:#fafafa;--fg:#111;--muted:#666;--card:#fff;--line:#e5e5e5;--accent:#111;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0b;--fg:#eee;--muted:#999;--card:#161616;--line:#2a2a2a;--accent:#eee;--accent-fg:#111}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{max-width:420px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}
a.btn,button.btn{display:block;text-align:center;padding:11px 14px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:10px;
border:1px solid var(--line);color:var(--fg);background:var(--card);width:100%;cursor:pointer}a.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.spin{width:22px;height:22px;border:3px solid var(--line);border-top-color:var(--fg);border-radius:50%;animation:s 1s linear infinite;margin-bottom:14px}
@keyframes s{to{transform:rotate(360deg)}}pre{white-space:pre-wrap;font-size:12px;color:var(--muted)}
</style></head><body><main class="card">${body}</main></body></html>`
}

export function signInPage(basePath: string, requested = basePath + "/") {
  const next = encodeURIComponent(requested.startsWith(basePath + "/") ? requested : basePath + "/")
  return page(
    "Sign in",
    `<h1>AinCode</h1>
<p>Sign in to ainize to open your coding workspace. You can build and manage the agents you own and the agents of your organizations.<br>ainize에 로그인하면 내 agent와 내 조직의 agent를 만들고 관리할 수 있는 작업 공간이 열립니다.</p>
<a class="btn primary" href="/api/auth/sso/start?next=${next}">Sign in with AIN</a>
<a class="btn" href="/signing?next=${next}">Other ways to sign in</a>`,
  )
}

export function startingPage() {
  return page(
    "Starting",
    `<div class="spin"></div><h1>Starting your workspace…</h1>
<p>This takes a few seconds the first time. The page reloads when it is ready.<br>작업 공간을 준비하고 있습니다.</p>
<script>setTimeout(function(){location.reload()},2000)</script>`,
    `<noscript><meta http-equiv="refresh" content="3"></noscript>`,
  )
}

export function errorPage(message: string) {
  return page(
    "Unavailable",
    `<h1>Your workspace could not start</h1><p>Try again in a moment. If this keeps happening, tell the ainize team.</p>
<pre>${esc(message.slice(0, 2000))}</pre><a class="btn" href="">Try again</a>`,
  )
}

export function workspacesPage(base: string, orgs: { id: string; name: string; role: string }[]) {
  return page("Workspaces", `<h1>작업 공간 / Workspaces</h1>
<p>조직 공간의 대화·파일·Git 기록은 같은 조직에 공유됩니다. 개인 공간의 기존 자료는 자동으로 옮기지 않습니다.<br>Organization conversations, files and Git history are shared with members. Personal work stays private.</p>
<a class="btn" href="${esc(base)}/builder">개인 공간 / Personal</a>
${orgs.map(org => `<a class="btn" href="${esc(base)}/org/${esc(org.id)}/_workspace">${esc(org.name)} · ${esc(org.role)}</a>`).join("")}`)
}

export function organizationPage(base: string, org: { name: string; role: string }, actor: string | undefined, mine: boolean) {
  const write = org.role === "admin" || org.role === "write"
  return page(org.name, `<h1>${esc(org.name)}</h1>
<p>조직 공용 대화·파일·Git / Shared conversations, files and Git.<br>접근 권한 / Access: ${esc(org.role)}</p>
<a class="btn primary" href="${esc(base)}/">공용 작업 공간 열기 / Open workspace</a>
${write ? `<a class="btn" href="${esc(base)}/builder">에이전트 만들기 / Build an agent</a>` : ""}
<p style="margin-top:20px">실행 계정 / Execution account: ${esc(actor ?? "연결 안 됨 / Not connected")}</p>
${write && (!actor || mine) ? `<form method="post" action="${esc(base)}/_workspace/activate">
<p>30분 동안 조직원의 모델 요청을 내 계정으로 실행합니다. 사용량은 내 계정에 기록됩니다. 개인 에이전트는 이 공간에서 접근할 수 없습니다.<br>Connect model execution for members for 30 minutes, billed to your account. Personal agents remain inaccessible.</p>
<button class="btn" type="submit">내 계정으로 실행 연결 / Connect execution</button></form>` : ""}
${mine ? `<form method="post" action="${esc(base)}/_workspace/release"><button class="btn" type="submit">실행 연결 해제 / Disconnect execution</button></form>` : ""}
<a class="btn" href="${esc(base.split("/org/")[0])}/_workspaces">작업 공간 선택 / Choose workspace</a>`)
}
