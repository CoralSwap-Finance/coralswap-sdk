let suppressWarnings = false;
const warnedMethods = new Set<string>();

/**
 * Enables or disables all deprecation warnings.
 * @param suppress - If true, all deprecation warnings will be suppressed.
 */
export function suppressDeprecationWarnings(suppress: boolean): void {
  suppressWarnings = suppress;
}

/**
 * Resets the internal state of the deprecation warning system.
 * This is intended for testing purposes only.
 */
export function resetDeprecationWarnings(): void {
  suppressWarnings = false;
  warnedMethods.clear();
}

/**
 * Logs a deprecation warning for a given method.
 * Warnings are shown only once per method per session.
 *
 * @param methodName - The name of the deprecated method.
 * @param message - A message explaining why the method is deprecated and how to migrate.
 * @param removalVersion - The version in which the method is expected to be removed.
 */
export function deprecated(
  methodName: string,
  message: string,
  removalVersion: string,
): void {
  if (suppressWarnings || warnedMethods.has(methodName)) {
    return;
  }

  warnedMethods.add(methodName);

  const stack = new Error().stack;
  // The stack trace will have 'Error' and 'deprecated' as the first two frames.
  // We want to skip these to show the caller.
  const filteredStack = stack
    ? stack.split('\n').slice(2).join('\n')
    : '';

// eslint-disable-next-line no-console
  console.warn(
    `[Deprecation Warning] Method "${methodName}" is deprecated and will be removed in version ${removalVersion}. ${message}\nStack trace:\n${filteredStack}`,
  );
}
