import { describe, expect, test } from "bun:test"
import { keepBasePath } from "./server"

function recorder() {
  const urls: string[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input))
      return new Response("{}")
    },
    { preconnect: () => {} },
  )
  return { urls, fetch }
}

describe("keepBasePath", () => {
  test("returns the original fetch when the server has no path prefix", () => {
    const { fetch } = recorder()
    expect(keepBasePath("http://localhost:4096", fetch)).toBe(fetch)
    expect(keepBasePath("http://localhost:4096/", fetch)).toBe(fetch)
  })

  test("re-applies a dropped prefix to same-origin requests only", async () => {
    const { urls, fetch } = recorder()
    const wrapped = keepBasePath("https://ainize.ai/code", fetch)!
    await wrapped(new URL("https://ainize.ai/api/health"))
    await wrapped("https://ainize.ai/code/api/health?x=1")
    await wrapped("https://ainize.ai/code")
    await wrapped("https://example.com/api/health")
    expect(urls).toEqual([
      "https://ainize.ai/code/api/health",
      "https://ainize.ai/code/api/health?x=1",
      "https://ainize.ai/code",
      "https://example.com/api/health",
    ])
  })
})
