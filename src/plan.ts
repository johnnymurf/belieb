/**
 * Read-only planning helpers for the plan/belieb mode pair.
 *
 * The safe-command policy is adapted from Pi's MIT-licensed plan-mode example
 * (examples/extensions/plan-mode), trimmed to what belieb needs.
 */

/** Built-in tools that can modify the workspace. */
export const planModeWriteTools = new Set(['edit', 'write']);

const destructivePatterns = [
  /\brm\b/i, /\brmdir\b/i, /\bmv\b/i, /\bcp\b/i, /\bmkdir\b/i, /\btouch\b/i,
  /\bchmod\b/i, /\bchown\b/i, /\bchgrp\b/i, /\bln\b/i, /\btee\b/i,
  /\btruncate\b/i, /\bdd\b/i, /\bshred\b/i, /(^|[^<])>(?!>)/, />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i, /\bsu\b/i, /\bkill\b/i, /\bpkill\b/i, /\bkillall\b/i,
  /\breboot\b/i, /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

const safePatterns = [
  /^\s*cat\b/, /^\s*head\b/, /^\s*tail\b/, /^\s*less\b/, /^\s*more\b/,
  /^\s*grep\b/, /^\s*find\b/, /^\s*ls\b/, /^\s*pwd\b/, /^\s*echo\b/,
  /^\s*printf\b/, /^\s*wc\b/, /^\s*sort\b/, /^\s*uniq\b/, /^\s*diff\b/,
  /^\s*file\b/, /^\s*stat\b/, /^\s*du\b/, /^\s*df\b/, /^\s*tree\b/,
  /^\s*which\b/, /^\s*whereis\b/, /^\s*type\b/, /^\s*env\b/, /^\s*printenv\b/,
  /^\s*uname\b/, /^\s*whoami\b/, /^\s*id\b/, /^\s*date\b/, /^\s*cal\b/,
  /^\s*uptime\b/, /^\s*ps\b/, /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*(node|python3?)\s+--version/i,
  /^\s*curl\s/i, /^\s*wget\s+-O\s*-/i, /^\s*jq\b/, /^\s*sed\s+-n/i,
  /^\s*awk\b/, /^\s*rg\b/, /^\s*fd\b/, /^\s*bat\b/, /^\s*eza\b/,
];

/** Redirects to a descriptor or /dev/null do not touch the workspace. */
function stripFdRedirects(command: string): string {
  return command
    .replace(/\d*>&\d+/g, ' ')
    .replace(/\d*>\s*\/dev\/(null|tty|stdout|stderr)/g, ' ');
}

/**
 * `curl` is allowed for reading, but its write and state-changing flags are not:
 * `-o/-O/-T/-X/-d/-F` can create files or mutate a remote resource.
 */
const curlWriteFlags = /(^|\s)(-o|-O|-T|-X|-d|-F|--data[a-z-]*|--form|--upload-file|--output|--request|--remote-name)(\s|=|$)/i;

function isSafeSegment(segment: string): boolean {
  if (destructivePatterns.some(pattern => pattern.test(segment))) return false;
  if (/^\s*curl\s/i.test(segment) && curlWriteFlags.test(segment)) return false;
  return safePatterns.some(pattern => pattern.test(segment));
}

/** Only allow commands that are both non-destructive and known to be read-only. */
export function isSafePlanCommand(command: string): boolean {
  // Command substitution can hide a write inside an otherwise safe command.
  if (/[`]|\$\(/.test(command)) return false;
  const segments = stripFdRedirects(command)
    .split(/\|\||&&|[;|\n]/)
    .map(segment => segment.trim())
    .filter(Boolean);
  return segments.length > 0 && segments.every(isSafeSegment);
}

/** Context injected before each user prompt while plan mode is active. */
export const PLAN_CONTEXT = `[PLAN MODE — READ-ONLY]
You are planning, not editing. The edit and write tools are disabled, and bash is
restricted to read-only commands.

Explore the code, ask clarifying questions, and reply with a numbered plan under a
"Plan:" header. Do not claim that changes were made. Wait for the user to switch
back to belieb mode before implementing anything.`;

/** True for the context messages this extension injects. */
export function isPlanContext(message: { customType?: string }): boolean {
  return message.customType === 'belieb-plan-context';
}
