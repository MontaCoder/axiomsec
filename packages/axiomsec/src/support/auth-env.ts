// Provider SDKs read keys from process.env. Remember which names AxiomSec
// injected so child processes can be spawned without them.
const injected = new Set<string>()

export function exportAuthEnv(name: string, value: string): string {
  if (process.env[name] === undefined) injected.add(name)
  process.env[name] = value
  return value
}

export function withoutAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (injected.size === 0) return env
  const copy = { ...env }
  for (const name of injected) delete copy[name]
  return copy
}
