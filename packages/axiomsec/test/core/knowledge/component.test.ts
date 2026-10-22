import { describe, expect, test } from "bun:test"
import { componentSearchTerms, normalizeComponent } from "@/core/knowledge/component"

describe("component normalization", () => {
  test("recognises nginx in common fingerprint forms", () => {
    for (const query of ["nginx 1.25.3", "nginx/1.25.3", "Server: nginx 1.25.3", "service:nginx 1.25.3"]) {
      const component = normalizeComponent(query)
      expect(component?.name).toBe("nginx")
      expect(component?.version).toBe("1.25.3")
      expect(component?.vendor).toBe("f5")
      expect(component?.type).toBe("service")
      expect(component?.confidence).toBe("high")
    }
  })

  test("recognises apache HTTPD and its aliases", () => {
    for (const query of ["apache 2.4.58", "httpd/2.4.58", "apache httpd 2.4.58", "apache2 2.4.58"]) {
      const component = normalizeComponent(query)
      expect(component?.name).toBe("apache httpd")
      expect(component?.version).toBe("2.4.58")
      expect(component?.vendor).toBe("apache")
      expect(component?.cpe_candidates).toContain("cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*")
    }
  })

  test("recognises OpenSSH banners", () => {
    const component = normalizeComponent("OpenSSH_9.6p1")
    expect(component?.name).toBe("openssh")
    expect(component?.version).toBe("9.6p1")
    expect(component?.vendor).toBe("openbsd")
  })

  test("strips a leading v from the version", () => {
    expect(normalizeComponent("nginx v1.24.0")?.version).toBe("1.24.0")
  })

  test("parses a CPE with vendor, product and exact version", () => {
    const component = normalizeComponent("cpe:2.3:a:openbsd:openssh:9.3p2:*:*:*:*:*:*:*")
    expect(component?.name).toBe("openssh")
    expect(component?.version).toBe("9.3p2")
    expect(component?.vendor).toBe("openbsd")
    expect(component?.type).toBe("cpe")
    expect(component?.confidence).toBe("high")
    expect(component?.cpe_candidates[0]).toContain("cpe:2.3:a:openbsd:openssh:9.3p2")
  })

  test("a CPE without a version is medium confidence", () => {
    const component = normalizeComponent("cpe:2.3:a:f5:nginx:*:*:*:*:*:*:*:*")
    expect(component?.version).toBeUndefined()
    expect(component?.confidence).toBe("medium")
  })

  test("keeps unknown products but flags them as unknown type", () => {
    const component = normalizeComponent("acme-widget 3.2.1")
    expect(component?.name).toBe("acme-widget")
    expect(component?.version).toBe("3.2.1")
    expect(component?.type).toBe("unknown")
    expect(component?.confidence).toBe("medium")
    expect(component?.cpe_candidates).toEqual([])
  })

  test("a lone known product has no version and medium confidence", () => {
    const component = normalizeComponent("nginx")
    expect(component?.name).toBe("nginx")
    expect(component?.version).toBeUndefined()
    expect(component?.confidence).toBe("medium")
  })

  test("empty and unrecognisable input is rejected", () => {
    expect(normalizeComponent("")).toBeUndefined()
    expect(normalizeComponent("   ")).toBeUndefined()
    expect(normalizeComponent("???")).toBeUndefined()
    expect(normalizeComponent("x 1.0")).toBeUndefined()
  })

  test("search terms dedupe aliases and include the canonical name", () => {
    const apache = normalizeComponent("apache 2.4.58")!
    expect(componentSearchTerms(apache)).toEqual(["apache httpd", "httpd", "apache"])
    const unknown = normalizeComponent("acme-widget 1.0")!
    expect(componentSearchTerms(unknown)).toEqual(["acme-widget"])
  })
})
