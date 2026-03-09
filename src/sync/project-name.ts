// ABOUTME: Extracts project name from .claude/projects/ directory paths
// ABOUTME: Handles worktrees, double-dash home paths, and cwd fallback

export function extractProjectName(dirName: string, cwd?: string): string {
  // If cwd is provided, extract the last path segment as project name
  if (cwd) {
    const segments = cwd.split('/').filter(Boolean);
    return segments[segments.length - 1];
  }

  // Strip leading dash and user path prefix
  // Patterns: -Users-xd-code-... or -Users-xd--...
  let path = dirName;

  // Remove leading -Users-<user>- prefix
  // Match: -Users-xd-code- or -Users-xd--
  const prefixMatch = path.match(/^-Users-[^-]+-(?:code-|-)(.+)$/);
  if (prefixMatch) {
    path = prefixMatch[1];
  } else {
    // Fallback: just strip leading dash
    path = path.replace(/^-/, '');
  }

  // Handle worktree paths: <project>-worktrees-<branch>
  const worktreeMatch = path.match(/^(.+?)-worktrees-/);
  if (worktreeMatch) {
    // The part before -worktrees- may include parent dirs (e.g., trading-tradebot)
    // Extract just the last segment before -worktrees-
    const prePath = worktreeMatch[1];
    const segments = prePath.split('-');
    // Find where the actual project name starts (after parent directories)
    // e.g., "trading-tradebot" -> "tradebot"
    return segments[segments.length - 1];
  }

  // For regular paths like "trading-tradebot", extract the last segment
  // But "private-journal-worker" should stay as-is (it's a single project with dashes)
  // Heuristic: if path has a known parent dir pattern, split on it
  const knownParents = ['trading'];
  for (const parent of knownParents) {
    if (path.startsWith(parent + '-')) {
      return path.slice(parent.length + 1);
    }
  }

  return path;
}
