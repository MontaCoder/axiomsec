import { describe, expect, test } from "bun:test"
import { createGitLab, gitlabOAuthTokenResponseSchema } from "gitlab-ai-provider"

// gitlab-ai-provider declares zod ^3, but its schemas only use object/string/
// number/record. The root override resolves it to zod 4 so the vulnerable zod 3
// copy is not installed; this smoke test proves the provider still loads and
// validates under that resolution. (RISK-DEP-02)
describe("gitlab provider zod override", () => {
  test("loads and validates its OAuth schema under the hoisted zod", () => {
    const valid = gitlabOAuthTokenResponseSchema.safeParse({
      access_token: "token",
      refresh_token: "refresh",
      expires_in: 3600,
      created_at: 1,
    })
    expect(valid.success).toBe(true)
    expect(gitlabOAuthTokenResponseSchema.safeParse({ access_token: "token" }).success).toBe(false)

    const provider = createGitLab({ apiKey: "test", instanceUrl: "https://gitlab.example.test" })
    expect(typeof provider.chat).toBe("function")
    expect(typeof provider.languageModel).toBe("function")
  })
})
