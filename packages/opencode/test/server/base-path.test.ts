import { describe, expect, test } from "bun:test"
import { BasePath } from "../../src/server/shared/base-path"

describe("BasePath", () => {
  test("normalizes the configured prefix", () => {
    expect(BasePath.normalize(undefined)).toBe("")
    expect(BasePath.normalize("")).toBe("")
    expect(BasePath.normalize("/")).toBe("")
    expect(BasePath.normalize("code")).toBe("/code")
    expect(BasePath.normalize("/code/")).toBe("/code")
  })

  test("strips the prefix and leaves other paths alone", () => {
    expect(BasePath.strip("/code", "/code")).toBe("/")
    expect(BasePath.strip("/code/", "/code")).toBe("/")
    expect(BasePath.strip("/code/session?x=1", "/code")).toBe("/session?x=1")
    expect(BasePath.strip("/code?x=1", "/code")).toBe("/?x=1")
    expect(BasePath.strip("/codex/session", "/code")).toBe("/codex/session")
    expect(BasePath.strip("/session", "/code")).toBe("/session")
    expect(BasePath.strip("/code/session", "")).toBe("/code/session")
  })

  test("rewrites the index.html base href", () => {
    const html = '<head><meta charset="utf-8" />\n<base href="/" /></head>'
    expect(BasePath.rewriteHtml(html, "/code")).toContain('<base href="/code/" />')
    expect(BasePath.rewriteHtml(html, "")).toBe(html)
  })
})
