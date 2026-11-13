/**
 * Every "N tools" claim about the MCP server names the number of tools it registers.
 *
 * The figure is hand-copied into the README, the guides, the feature docs, the site
 * components, the Open Graph covers, the plugin skill and the agent profile. It drifted
 * once (75 in some components while the server registered 79), so the expected value
 * is derived from TOOL_POLICIES: the tools that are not optional are the primary tools
 * registered by default. Claims below 20 are sub-counts (toolsets, discovery or
 * workflow tools) and are not checked here.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_POLICIES } from '../src/mcp/toolPolicy';

const ROOT = join(import.meta.dir, '..');
const PRIMARY = Object.values(TOOL_POLICIES).filter((policy) => !policy.optional).length;
const CLAIM = /\b(\d+)(?: primary)?(?: MCP)? tools\b/g;

/** Files copied into the sandbox test image: each must exist. */
const REQUIRED = [
  'README.md',
  'docs/README.md',
  'docs/architecture.md',
  'docs/features/mcp-server.md',
  'docs/features/documentation-tooling.md',
  'docs/src/content/docs/guide/mcp.mdx',
  'docs/src/content/docs/guide/introduction.mdx',
  'docs/src/content/docs/guide/quickstart.mdx',
  'docs/src/content/docs/guide/server.md',
];

/** Site and plugin files outside the sandbox image: checked wherever they exist. */
const OUTSIDE_IMAGE = [
  'docs/public/llms.txt',
  'docs/scripts/og-covers.ts',
  'docs/src/components/AiAgentWorkflow.astro',
  'docs/src/components/McpArchitecture.astro',
  'docs/src/components/home/HomeAgents.astro',
  'skills/bunqueue/mcp.md',
  'skills/bunqueue/queue-patterns.md',
  'agents/bunqueue-assistant.md',
  '.claude-plugin/plugin.json',
];

function claims(path: string): Array<{ claim: string; count: number }> {
  const text = readFileSync(join(ROOT, path), 'utf8');
  return [...text.matchAll(CLAIM)]
    .map((match) => ({ claim: `${path}: ${match[0]}`, count: Number(match[1]) }))
    .filter(({ count }) => count >= 20);
}

describe('MCP tool count in the docs', () => {
  test('the primary tool count is derived from TOOL_POLICIES', () => {
    expect(PRIMARY).toBeGreaterThanOrEqual(20);
  });

  test('every claim names the registered primary tool count', () => {
    const missing = REQUIRED.filter((path) => !existsSync(join(ROOT, path)));
    expect(missing).toEqual([]);
    const files = [...REQUIRED, ...OUTSIDE_IMAGE.filter((path) => existsSync(join(ROOT, path)))];
    const all = files.flatMap(claims);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(({ count }) => count !== PRIMARY).map(({ claim }) => claim)).toEqual([]);
  });
});
