import { describe, expect, test } from "bun:test"
import { containedPath, isValidSlug } from "@/core/operation/slug"
import path from "path"

describe("operation slug validation (RISK-SCOPE-07)", () => {
  test("accepts slugs produced by safeSlug", () => {
    expect(isValidSlug("verify")).toBe(true)
    expect(isValidSlug("verify-20260101")).toBe(true)
    expect(isValidSlug("op-abc123")).toBe(true)
    expect(isValidSlug("legacy-op")).toBe(true)
    expect(isValidSlug("a")).toBe(true)
  })

  test("rejects path traversal", () => {
    expect(isValidSlug("..")).toBe(false)
    expect(isValidSlug("../..")).toBe(false)
    expect(isValidSlug("../../evil")).toBe(false)
    expect(isValidSlug("foo/../bar")).toBe(false)
    expect(isValidSlug("foo/bar")).toBe(false)
    expect(isValidSlug("foo\\bar")).toBe(false)
  })

  test("rejects absolute paths and drive letters", () => {
    expect(isValidSlug("/etc/passwd")).toBe(false)
    expect(isValidSlug("C:/Windows")).toBe(false)
    expect(isValidSlug("C:\\Windows")).toBe(false)
  })

  test("rejects empty, oversized and non-string input", () => {
    expect(isValidSlug("")).toBe(false)
    expect(isValidSlug("a".repeat(65))).toBe(false)
    expect(isValidSlug(undefined)).toBe(false)
    expect(isValidSlug(null)).toBe(false)
    expect(isValidSlug(123)).toBe(false)
  })

  test("rejects leading dot so a slug can never be a parent reference", () => {
    expect(isValidSlug(".hidden")).toBe(false)
    expect(isValidSlug(".config")).toBe(false)
  })
})

describe("containedPath", () => {
  const root = path.resolve("/tmp/workspace/.axiomsec/operation")

  test("resolves a normal slug under the root", () => {
    expect(containedPath(root, "verify")).toBe(path.join(root, "verify"))
  })

  test("throws for a traversal slug instead of returning a fallback", () => {
    expect(() => containedPath(root, "../..")).toThrow(/Invalid operation slug/)
    expect(() => containedPath(root, "../../evil")).toThrow(/Invalid operation slug/)
  })

  test("never resolves outside the root", () => {
    for (const slug of ["..", "../..", "../../evil", "foo/../../bar", "/abs", "C:/x"]) {
      let resolved: string | undefined
      try {
        resolved = containedPath(root, slug)
      } catch {
        resolved = undefined
      }
      if (resolved !== undefined) {
        expect(resolved.startsWith(root + path.sep)).toBe(true)
      }
    }
  })
})
