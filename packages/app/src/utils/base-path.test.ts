import { describe, expect, test } from "bun:test"
import { routePath } from "./base-path"

describe("routePath", () => {
  test("is the identity without a base", () => {
    expect(routePath("/new-session", "")).toBe("/new-session")
    expect(routePath("/", "")).toBe("/")
  })

  test("strips the router base from the browser path", () => {
    expect(routePath("/code/new-session", "/code")).toBe("/new-session")
    expect(routePath("/code/abc/session/ses_1", "/code")).toBe("/abc/session/ses_1")
    expect(routePath("/code/", "/code")).toBe("/")
    expect(routePath("/code", "/code")).toBe("/")
  })

  test("leaves paths outside the base, and look-alike prefixes, alone", () => {
    expect(routePath("/codex/new-session", "/code")).toBe("/codex/new-session")
    expect(routePath("/new-session", "/code")).toBe("/new-session")
  })
})
