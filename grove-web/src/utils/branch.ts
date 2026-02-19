/**
 * Branch name utilities - matches TUI implementation in src/storage/tasks.rs
 */

/**
 * Generate slug from text (matches TUI to_slug)
 * - Convert to lowercase
 * - Replace non-alphanumeric chars with '-'
 * - Remove empty segments
 *
 * @example "Add OAuth" → "add-oauth"
 * @example "Fix: header bug!" → "fix-header-bug"
 */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .split('-')
    .filter((s) => s.length > 0)
    .join('-');
}

/**
 * Truncate slug to maximum N words (hyphen-separated segments)
 */
function truncateToWords(slug: string, maxWords: number): string {
  return slug.split('-').slice(0, maxWords).join('-');
}

/**
 * Generate branch name preview (matches TUI preview_branch_name)
 *
 * Rules:
 * 1. Default prefix is "grove/"
 * 2. Custom prefix: if input contains "/", use first part as prefix
 *    - "feature/oauth login" → "feature/oauth-login-<hash>"
 *    - "fix/header bug" → "fix/header-bug-<hash>"
 * 3. Maximum 3 words per section (truncated if longer)
 * 4. Shows "<hash>" placeholder instead of actual hash
 *
 * @example "auth bug" → "grove/auth-bug-<hash>"
 * @example "feature/oauth login" → "feature/oauth-login-<hash>"
 */
export function previewBranchName(taskName: string): string {
  const trimmed = taskName.trim();
  if (!trimmed) {
    return 'grove/task-<hash>';
  }

  const slashIdx = trimmed.indexOf('/');

  if (slashIdx !== -1) {
    // User provided a custom prefix
    const prefix = toSlug(trimmed.slice(0, slashIdx));
    const body = truncateToWords(toSlug(trimmed.slice(slashIdx + 1)), 3);

    if (!prefix) {
      // Empty prefix (e.g., "/xxx") → use default "grove/"
      return body ? `grove/${body}-<hash>` : 'grove/task-<hash>';
    }
    return body ? `${prefix}/${body}-<hash>` : `${prefix}/task-<hash>`;
  }

  // No "/" → use default "grove/" prefix
  const slug = truncateToWords(toSlug(trimmed), 3);
  return slug ? `grove/${slug}-<hash>` : 'grove/task-<hash>';
}
