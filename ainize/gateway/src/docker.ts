import { execFile } from "node:child_process"

export interface DockerResult {
  code: number
  stdout: string
  stderr: string
}

export function docker(args: string[], timeoutMs = 120_000): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function dockerOk(args: string[], timeoutMs?: number): Promise<string> {
  const r = await docker(args, timeoutMs)
  if (r.code !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`)
  return r.stdout.trim()
}
