export type CheckKind = 'tests' | 'lint' | 'build';

/** Stable display order for footer badges. */
export const checkOrder: readonly CheckKind[] = ['tests', 'lint', 'build'];

const TEST_PATTERN = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|jest|vitest|mocha)\b|\b(swift\s+test|cargo\s+test|go\s+test|xcodebuild\s+test|make\s+(test|check))\b/i;
const LINT_PATTERN = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck)\b|\b(eslint|biome|swiftlint|rubocop|mypy|tsc)\b|\bmake\s+lint\b/i;
const BUILD_PATTERN = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(make|swift\s+build|cargo\s+build|go\s+build|xcodebuild\s+build)\b/i;

/** Classify a shell command as a test, lint/typecheck or build run. */
export function checkKind(command: string): CheckKind | undefined {
  if (TEST_PATTERN.test(command)) return 'tests';
  if (LINT_PATTERN.test(command)) return 'lint';
  if (BUILD_PATTERN.test(command)) return 'build';
  return undefined;
}
