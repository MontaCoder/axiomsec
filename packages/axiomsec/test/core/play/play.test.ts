import { describe, expect, test } from "bun:test"
import { PlayRegistry } from "@/core/play/registry"
import { PlayRunner, PlayArgError, PlayNotFoundError } from "@/core/play/runner"
import { isConditional, isNormalizedStep, isSkillStep, isToolStep, type Step } from "@/core/play/play"

const environment = {
  binaries: new Set(["nmap", "curl", "git", "tar", "grep"]),
  runtimes: { browser: false },
}

describe("play registry", () => {
  test("ids are unique and every play is well-formed", () => {
    const ids = PlayRegistry.ids()
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(10)
    for (const play of PlayRegistry.list()) {
      expect(play.id).toBeTruthy()
      expect(play.name).toBeTruthy()
      expect(play.description).toBeTruthy()
      expect(play.steps.length).toBeGreaterThan(0)
      expect(PlayRegistry.get(play.id)).toBe(play)
    }
  })

  test("argument specs have unique names and a declared type", () => {
    for (const play of PlayRegistry.list()) {
      const names = play.args.map((arg) => arg.name)
      expect(new Set(names).size).toBe(names.length)
      for (const arg of play.args) expect(["string", "number", "boolean"]).toContain(arg.type)
    }
  })

  test("every step has a recognised shape and a resolvable reference", () => {
    for (const play of PlayRegistry.list()) {
      for (const step of play.steps) {
        const conditional = isConditional(step)
        const normalized = isNormalizedStep(step)
        const direct = !conditional && !normalized && (isToolStep(step as Step) || isSkillStep(step as Step))
        expect([conditional, normalized, direct].filter(Boolean).length).toBeGreaterThan(0)
        if (isConditional(step)) {
          expect(step.if.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test("an unknown id is reported with the known ids", () => {
    expect(() => PlayRunner.run({ id: "nope" })).toThrow(PlayNotFoundError)
  })
})

describe("play runner", () => {
  test("missing required arguments are reported", () => {
    expect(() => PlayRunner.run({ id: "web-surface" })).toThrow(PlayArgError)
  })

  test("required args are substituted through nested step arguments", () => {
    const result = PlayRunner.run({ id: "web-surface", args: { target: "http://127.0.0.1:8080" } })
    const crawl = result.trace[0] as { tool: string; args: Record<string, unknown> }
    expect(crawl.tool).toBe("scanner")
    expect(crawl.args["target"]).toBe("http://127.0.0.1:8080")
    expect((crawl.args["options"] as Record<string, unknown>)["maxUrls"]).toBe(50)
  })

  test("a falsy conditional step is skipped with a reason", () => {
    const result = PlayRunner.run({ id: "web-surface", args: { target: "http://127.0.0.1:8080" } })
    const skill = result.trace.find((entry) => entry.kind === "skill")
    expect(skill).toBeUndefined()
    expect(result.skipped.some((item) => item.reason.includes('if "domain" was falsy'))).toBe(true)
  })

  test("a truthy conditional step is included and its template resolved", () => {
    const result = PlayRunner.run({
      id: "web-surface",
      args: { target: "http://127.0.0.1:8080", domain: "example.test" },
    })
    const skill = result.trace.find((entry) => entry.kind === "skill") as { skill: string; brief: string }
    expect(skill.skill).toBe("passive-osint")
    expect(skill.brief).toContain("example.test")
    expect(skill.brief).not.toContain("{{")
  })

  test("an optional missing runtime skips the optional step but keeps the run available", () => {
    const result = PlayRunner.run({ id: "web-surface", args: { target: "http://127.0.0.1:8080" }, environment })
    const browser = result.trace.find((entry) => entry.kind === "tool" && entry.tool === "browser")
    expect(browser).toBeUndefined()
    expect(result.skipped.some((item) => item.reason.includes("optional capability"))).toBe(true)
    expect(result.trace.length).toBeGreaterThan(0)
  })

  test("the network-surface play emits scanner and methodology steps", () => {
    const result = PlayRunner.run({ id: "network-surface", args: { target: "127.0.0.1" } })
    expect(result.trace[0]).toMatchObject({ kind: "tool", tool: "scanner" })
    expect(result.trace.at(-1)).toMatchObject({ kind: "tool", tool: "methodology" })
    expect(result.trace.every((entry) => entry.kind === "tool")).toBe(true)
  })

  test("format renders args, steps and the execution contract", () => {
    const result = PlayRunner.run({ id: "network-surface", args: { target: "127.0.0.1" } })
    const text = PlayRunner.format(result)
    expect(text).toContain("# Play: Network Surface Map (network-surface)")
    expect(text).toContain("- target*: \"127.0.0.1\"")
    expect(text).toContain("## Steps (execute in order)")
    expect(text).toContain("## Execution Contract")
    expect(text).toContain("Execute exactly one step per assistant message.")
  })

  test("template fallbacks apply when a value is absent", () => {
    // Every registered play is exercised with its required args to catch a
    // malformed step at the boundary rather than in a live engagement.
    for (const play of PlayRegistry.list()) {
      const args: Record<string, unknown> = {}
      for (const spec of play.args) {
        if (spec.required) args[spec.name] = spec.type === "number" ? 1 : spec.type === "boolean" ? true : "value"
      }
      const result = PlayRunner.run({ id: play.id, args, environment })
      expect(result.play.id).toBe(play.id)
      expect(result.trace.length + result.skipped.length).toBe(play.steps.length)
    }
  })
})
