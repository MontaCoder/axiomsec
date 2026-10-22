import { describe, expect, test } from "bun:test"
import { progress, project } from "@/core/plan/info"
import type { Event } from "@/core/plan/events"

const added = (id: string, at: number, title = id): Event => ({ type: "node_added", id, at, title })

describe("plan event projection", () => {
  test("adds nodes in order with planned status", () => {
    const nodes = project([added("a", 1), added("b", 2)])
    expect(nodes.map((node) => node.id)).toEqual(["a", "b"])
    expect(nodes.every((node) => node.status === "planned")).toBe(true)
  })

  test("updates status, title and note", () => {
    const nodes = project([
      added("a", 1),
      { type: "node_updated", id: "a", at: 2, status: "running", title: "new", note: "n" },
    ])
    expect(nodes[0]).toMatchObject({ status: "running", title: "new", note: "n", updated_at: 2 })
  })

  test("moving a node changes its parent", () => {
    const nodes = project([added("a", 1), added("b", 2), { type: "node_moved", id: "b", at: 3, parent_id: "a" }])
    expect(nodes[1]?.parent_id).toBe("a")
  })

  test("moving to the root clears the parent", () => {
    const nodes = project([
      added("a", 1),
      { type: "node_added", id: "b", at: 2, title: "b", parent_id: "a" },
      { type: "node_moved", id: "b", at: 3 },
    ])
    expect(nodes[1]?.parent_id).toBeUndefined()
  })

  test("removal is final and ignored for unknown ids", () => {
    const nodes = project([
      added("a", 1),
      added("b", 2),
      { type: "node_removed", id: "a", at: 3 },
      { type: "node_removed", id: "missing", at: 4 },
      { type: "node_updated", id: "a", at: 5, status: "done" },
    ])
    expect(nodes.map((node) => node.id)).toEqual(["b"])
  })

  test("progress counts statuses and total", () => {
    const nodes = project([
      added("a", 1),
      added("b", 2),
      added("c", 3),
      added("d", 4),
      { type: "node_updated", id: "a", at: 5, status: "done" },
      { type: "node_updated", id: "b", at: 6, status: "running" },
      { type: "node_updated", id: "c", at: 7, status: "blocked" },
    ])
    expect(progress(nodes)).toEqual({ done: 1, running: 1, blocked: 1, total: 4 })
    expect(progress([])).toEqual({ done: 0, running: 0, blocked: 0, total: 0 })
  })
})
