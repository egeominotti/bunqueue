/** Resolve the opt-in agent preset without changing the caller's environment. */
export function agentProfileFromEnv(env: NodeJS.ProcessEnv = process.env): {
  profile: 'agent' | 'default';
  env: NodeJS.ProcessEnv;
} {
  const profile = env.BUNQUEUE_MCP_PROFILE?.trim().toLowerCase();
  if (profile && profile !== 'agent') {
    throw new Error('BUNQUEUE_MCP_PROFILE must be "agent" when set');
  }
  return {
    profile: profile ? ('agent' as const) : ('default' as const),
    env: profile
      ? {
          ...env,
          BUNQUEUE_MCP_TOOLSETS: env.BUNQUEUE_MCP_TOOLSETS ?? 'dynamic',
          BUNQUEUE_MCP_CONFIRM: env.BUNQUEUE_MCP_CONFIRM ?? 'destructive',
        }
      : { ...env },
  };
}
