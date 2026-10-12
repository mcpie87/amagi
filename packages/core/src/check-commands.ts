type Checks = {
  format: string | null
  lint: string | null
  test: string | null
  commands: readonly string[]
}

export function configuredCheckCommands(
  checks: Checks,
  options: { includeTest?: boolean; includeCommands?: boolean } = {},
): string[] {
  const { includeTest = true, includeCommands = true } = options
  const commands = [checks.format, checks.lint]
  if (includeTest) commands.push(checks.test)
  if (includeCommands) commands.push(...checks.commands)
  return commands.filter((command): command is string => command !== null && command !== '')
}
