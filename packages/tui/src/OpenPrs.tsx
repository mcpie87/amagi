import type { PrInfo } from '@amagi/core'
import { Box, Text, useInput } from 'ink'

export function OpenPrs({ prs, onBack }: { prs: PrInfo[]; onBack: () => void }) {
  useInput((input, key) => {
    if (input === 'q' || key.escape) onBack()
  })

  return (
    <Box flexDirection="column">
      <Text bold>open pull requests ({prs.length})</Text>
      {prs.length === 0 ? (
        <Text dimColor>none</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {prs.map((pr) => (
            <Box key={pr.number} flexDirection="column" marginBottom={1}>
              <Text>
                <Text
                  color={
                    pr.mergeable === 'MERGEABLE' || pr.mergeStateStatus === 'CLEAN'
                      ? 'green'
                      : pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'
                        ? 'red'
                        : 'gray'
                  }
                >
                  {pr.mergeable === 'MERGEABLE' || pr.mergeStateStatus === 'CLEAN'
                    ? 'mergeable'
                    : pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY'
                      ? 'conflict'
                      : 'unknown'}
                </Text>{' '}
                #{pr.number} {pr.title}
              </Text>
              <Text dimColor>
                {pr.headRefName} → {pr.baseRefName} · {pr.url}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>esc/q back</Text>
      </Box>
    </Box>
  )
}
