/**
 * Process-wide runtime state set by the server `init` hook and read by
 * health/readiness endpoints. Contains no user or request data.
 */
export const appState = {
	migrationsApplied: false
};
