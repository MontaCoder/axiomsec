/**
 * Scanner: service prober
 *
 * Protocol detection on open ports. Sends protocol-specific probes
 * and identifies services by response patterns.
 */

import { connect } from "net"

export interface ServiceInfo {
  port: number
  protocol: string
  service: string
  version?: string
  banner?: string
  tls: boolean
}

export interface ServiceProbeResult {
  services: ServiceInfo[]
  elapsed: number
}

const PROBES: { name: string; probe: Buffer | string; match: RegExp; protocol: string }[] = [
  { name: "HTTP", probe: "GET / HTTP/1.1\r\nHost: target\r\n\r\n", match: /HTTP\/[12]/, protocol: "http" },
  { name: "SSH", probe: "", match: /^SSH-/, protocol: "ssh" },
  { name: "FTP", probe: "", match: /^220[\s-]/, protocol: "ftp" },
  { name: "SMTP", probe: "", match: /^220.*(?:SMTP|mail)/i, protocol: "smtp" },
  { name: "POP3", probe: "", match: /^\+OK/i, protocol: "pop3" },
  { name: "IMAP", probe: "", match: /^\* OK.*IMAP/i, protocol: "imap" },
  { name: "MySQL", probe: "", match: /mysql|MariaDB/i, protocol: "mysql" },
  { name: "PostgreSQL", probe: "", match: /PostgreSQL|invalid length of startup packet/i, protocol: "postgresql" },
  { name: "Redis", probe: "PING\r\n", match: /^\+PONG|-ERR|-NOAUTH/i, protocol: "redis" },
  { name: "MongoDB", probe: "", match: /MongoDB|ismaster/i, protocol: "mongodb" },
  { name: "Memcached", probe: "version\r\n", match: /^VERSION /i, protocol: "memcached" },
  { name: "RDP", probe: "", match: /^\x03\x00/, protocol: "rdp" },
]

function probeService(host: string, port: number, timeout: number): Promise<ServiceInfo | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let connected = false
    let settled = false
    let probed = false

    const finish = (info: ServiceInfo | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(info)
    }

    const identify = (banner: string): ServiceInfo => {
      for (const probe of PROBES) {
        if (probe.match.test(banner)) {
          return {
            port,
            protocol: probe.protocol,
            service: probe.name,
            banner: banner.slice(0, 200),
            tls: false,
          }
        }
      }
      return {
        port,
        protocol: "unknown",
        service: "unknown",
        banner: banner.slice(0, 200),
        tls: false,
      }
    }

    socket.setTimeout(timeout)
    socket.once("connect", () => {
      connected = true
      socket.setTimeout(Math.min(2000, timeout))
    })
    socket.once("data", (data) => finish(identify(data.toString("utf-8").trim())))
    socket.once("timeout", () => {
      if (!connected) return finish(null)
      if (!probed) {
        // No spontaneous banner — send the first active probe and wait once.
        const active = PROBES.find((probe) => probe.probe)
        if (!active) return finish({ port, protocol: "unknown", service: "unknown", tls: false })
        probed = true
        socket.setTimeout(Math.min(2000, timeout))
        socket.write(active.probe)
        return
      }
      // The port accepted a connection but did not answer any probe.
      finish({ port, protocol: "unknown", service: "filtered", tls: false })
    })
    socket.once("error", () => finish(null))
  })
}

/**
 * Probe services on specified ports.
 */
export async function probeServices(
  host: string,
  ports: number[],
  options: { concurrency?: number; timeout?: number } = {},
): Promise<ServiceProbeResult> {
  const concurrency = options.concurrency ?? 10
  const timeout = options.timeout ?? 5000
  const start = Date.now()
  const services: ServiceInfo[] = []

  for (let i = 0; i < ports.length; i += concurrency) {
    const batch = ports.slice(i, i + concurrency)
    const results = await Promise.all(batch.map((p) => probeService(host, p, timeout)))
    for (const r of results) {
      if (r) services.push(r)
    }
  }

  return { services, elapsed: Date.now() - start }
}
