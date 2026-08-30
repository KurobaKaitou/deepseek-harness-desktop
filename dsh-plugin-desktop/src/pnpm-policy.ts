/** Desktop-wide pnpm policy applied to every package-manager operation. */

/**
 * DSH Desktop accepts explicitly requested package versions immediately.
 * Keep this process-local: never rewrite a user's pnpm configuration file.
 */
export const PNPM_IGNORE_MINIMUM_RELEASE_AGE = '--config.minimumReleaseAge=0'

/**
 * Prefix a direct pnpm argv without adding the same Desktop policy twice.
 *
 * The command shims also hardcode the policy argument ahead of the caller's
 * argv, so a caller that already carries the flag would see it twice — pnpm
 * aggregates repeated `--config` keys into an array and its release-age date
 * math aborts the whole resolution on that shape. The shims' preloaded
 * clear-environment module collapses such duplicates down to the last one;
 * this helper keeps the direct spawn path clean without relying on it.
 */
export function withDesktopPnpmPolicy(argv: readonly string[]): string[] {
  if (argv.includes(PNPM_IGNORE_MINIMUM_RELEASE_AGE)) return [...argv]
  return [PNPM_IGNORE_MINIMUM_RELEASE_AGE, ...argv]
}

/**
 * `dsh plugin` ultimately resolves the Desktop pnpm shim, which owns the one
 * policy argument. Remove an eagerly forwarded copy before that boundary.
 */
export function withoutForwardedDesktopPnpmPolicy(argv: readonly string[]): string[] {
  if (argv[0] !== 'plugin') return [...argv]
  return argv.filter((argument, index) => index === 0 || argument !== PNPM_IGNORE_MINIMUM_RELEASE_AGE)
}
