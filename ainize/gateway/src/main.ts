/**
 * aincode-gateway — serves ainize.ai/code: one sandboxed AinCode workspace per signed-in ainize user.
 *
 *   browser ──nginx /code/──▶ public listener (127.0.0.1:3950) ──in.sock──▶ the person's container
 *   container ──out.sock──▶ egress (model + ainize API, as that person) ──▶ ainize web (127.0.0.1:3900)
 *
 * Run: node ainize/gateway/src/main.ts (Node ≥ 23.6 runs the TypeScript directly). Configuration: config.ts.
 */
import { mkdirSync } from "node:fs"
import { loadConfig } from "./config.ts"
import { Egress, Sessions } from "./egress.ts"
import { IdentityResolver } from "./identity.ts"
import { KeyStore } from "./keys.ts"
import { PublicProxy } from "./public.ts"
import { Sandboxes } from "./sandboxes.ts"

const cfg = loadConfig()
mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })

const sessions = new Sessions()
const keys = new KeyStore(cfg.stateDir, cfg.ainize, cfg.keyLabel)
let egress: Egress
const boxes = new Sandboxes(cfg, (sb) => egress.listen(sb))
egress = new Egress(cfg, keys, sessions, (sb) => boxes.touch(sb))
const ids = new IdentityResolver(cfg.ainize)
const proxy = new PublicProxy(cfg, ids, boxes, sessions)

await boxes.boot()
const server = proxy.server()
server.listen(cfg.port, cfg.host, () => {
  console.log(
    `[aincode-gateway] ${cfg.host}:${cfg.port}${cfg.basePath}/ → ${cfg.image}; ainize ${cfg.ainize}; ` +
      `idle ${Math.round(cfg.idleMs / 1000)}s; max ${cfg.maxRunning} running; state ${cfg.stateDir}`,
  )
})

// Workspaces keep running across a gateway restart; the next gateway picks them up in boot().
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    boxes.stopSweeper()
    server.close()
    void egress.closeAll()
    setTimeout(() => process.exit(0), 500).unref()
  })
}
