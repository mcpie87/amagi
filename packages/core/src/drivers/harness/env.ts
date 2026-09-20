const FORGE_CREDENTIAL =
  /^(GH_TOKEN|GITHUB_TOKEN|GITEA_SERVER_(TOKEN|USER|PASSWORD|OTP)|TEA_TOKEN)$/

export function harnessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !FORGE_CREDENTIAL.test(name)),
  ) as Record<string, string>
}
