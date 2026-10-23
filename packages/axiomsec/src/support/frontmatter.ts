import { dump, load } from "js-yaml"

export type Frontmatter = {
  data: Record<string, any>
  content: string
}

export function parse(input: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input)
  if (!match) return { data: {}, content: input }
  const parsed = load(match[1])
  return {
    data: parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {},
    content: input.slice(match[0].length),
  }
}

export function stringify(content: string, data: Record<string, unknown>): string {
  return `---\n${dump(data).trimEnd()}\n---\n${content}`
}
