declare global {
  const AXIOMSEC_VERSION: string
  const AXIOMSEC_CHANNEL: string
}

export const InstallationVersion = typeof AXIOMSEC_VERSION === "string" ? AXIOMSEC_VERSION : "local"
export const InstallationChannel = typeof AXIOMSEC_CHANNEL === "string" ? AXIOMSEC_CHANNEL : "local"
export const InstallationLocal = InstallationVersion === "local"
