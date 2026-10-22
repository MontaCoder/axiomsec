export type RunResult = { argv: string[]; stdout: string; stderr: string; exitCode: number; timedOut: boolean }

export async function runProcess(argv: string[], options: { timeoutMs?: number } = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs ?? 10 * 60 * 1000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { argv, stdout, stderr, exitCode, timedOut: proc.signalCode !== null }
}
