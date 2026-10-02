#!/usr/bin/env bun
/**
 * Toolset routing evaluation for the MCP server's dynamic tool disclosure.
 *
 * Dataset: toolset-routing.json, 72 plain-language requests (36 development, 36
 * held-out, including paraphrases and Italian), each with the tool(s) that fulfil it.
 * A request is routed correctly when the chosen toolset contains one of those tools
 * (src/mcp/toolPolicy.ts), which is what `bunqueue_find_tools` needs.
 *
 * Model mode asks the configured decision model exactly what `bunqueue_find_tools`
 * asks (FIND_TOOLS_QUESTION over the toolset catalog):
 *   BUNQUEUE_MCP_DECISION_PROVIDER=typesafe BUNQUEUE_MCP_DECISION_API_KEY=... \
 *     bun scripts/mcp-eval/toolset-routing.ts
 *
 * Lexical mode is the baseline that motivated the decision model: BM25 over the name,
 * description and parameter descriptions of every individual tool, reporting how often
 * a needed tool ranks first and in the top 5:
 *   bun scripts/mcp-eval/toolset-routing.ts --lexical
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DecisionModel, decisionConfigFromEnv } from '../../src/mcp/decisionModel';
import { TOOL_POLICIES, TOOLSETS, TOOLSET_IDS } from '../../src/mcp/toolPolicy';
import { setupTools } from '../../src/mcp/toolSetup';
import { FIND_TOOLS_QUESTION } from '../../src/mcp/toolsets';

interface Case {
  split: 'dev' | 'test';
  q: string;
  /** Tool names without the `bunqueue_` prefix; any of them fulfils the request. */
  expect: string[];
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { description?: string }> };
}

const cases = JSON.parse(
  readFileSync(join(import.meta.dir, 'toolset-routing.json'), 'utf8')
) as Case[];

const toolsetOf = (tool: string) => TOOL_POLICIES[`bunqueue_${tool}`]?.toolset;

function report(label: string, hits: Record<string, number>, misses: string[]) {
  for (const split of ['dev', 'test'] as const) {
    const total = cases.filter((c) => c.split === split).length;
    console.log(`${label} ${split}: ${hits[split] ?? 0}/${total}`);
  }
  for (const miss of misses) console.log(`  miss: ${miss}`);
}

async function modelMode(): Promise<void> {
  const config = decisionConfigFromEnv();
  if (!config) {
    console.error(
      'Set BUNQUEUE_MCP_DECISION_PROVIDER and its key (see docs/features/mcp-server.md), or pass --lexical'
    );
    process.exit(1);
  }
  const model = new DecisionModel(config);
  // The catalog bunqueue_find_tools offers when the optional workflow tools are off.
  const ids = TOOLSET_IDS.filter((id) => id !== 'workflows');
  const catalog = Object.fromEntries(ids.map((id) => [id, TOOLSETS[id]]));
  const hits: Record<string, number> = {};
  const misses: string[] = [];
  for (const c of cases) {
    const answer = await model.choice(c.q, FIND_TOOLS_QUESTION, catalog);
    const expected = new Set(c.expect.map(toolsetOf));
    if (expected.has(answer.choice as never)) hits[c.split] = (hits[c.split] ?? 0) + 1;
    else misses.push(`[${c.split}] ${c.q} -> ${answer.choice} (want ${[...expected].join('|')})`);
  }
  report(`${config.provider}/${config.model}`, hits, misses);
}

/** The default tool list exactly as an MCP client receives it. */
async function listTools(): Promise<ListedTool[]> {
  const server = new McpServer({ name: 'bunqueue-mcp', version: 'eval' });
  const backend = new Proxy({}, { get: () => () => Promise.resolve({}) }) as never;
  const handlers = { register() {}, unregister() {}, list: () => [], shutdown() {} } as never;
  setupTools(server, backend, handlers, { env: {}, decision: null });
  const client = new Client({ name: 'eval', version: '1.0.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools as ListedTool[];
}

const stem = (word: string) => word.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '');
const terms = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(stem).filter((w) => w.length > 1);

async function lexicalMode(): Promise<void> {
  const tools = await listTools();
  const docs = tools.map((t) => {
    const name = t.name.replace(/^bunqueue_/, '').replace(/_/g, ' ');
    const params = Object.entries(t.inputSchema.properties ?? {})
      .map(([key, value]) => `${key} ${value.description ?? ''}`)
      .join(' ');
    return terms(`${name} ${name} ${t.description ?? ''} ${params}`);
  });
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const doc of docs) for (const w of new Set(doc)) df.set(w, (df.get(w) ?? 0) + 1);
  const rank = (query: string) =>
    tools
      .map((tool, i) => {
        let score = 0;
        for (const w of new Set(terms(query))) {
          const f = docs[i].filter((x) => x === w).length;
          if (!f) continue;
          const n = df.get(w) ?? 0;
          const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
          score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * docs[i].length) / avg));
        }
        return { name: tool.name.replace(/^bunqueue_/, ''), score };
      })
      .sort((a, b) => b.score - a.score)
      .map((r) => r.name);

  const top1: Record<string, number> = {};
  const top5: Record<string, number> = {};
  const misses: string[] = [];
  for (const c of cases) {
    const ranked = rank(c.q);
    const pos = Math.min(...c.expect.map((e) => (ranked.includes(e) ? ranked.indexOf(e) : 999)));
    if (pos < 1) top1[c.split] = (top1[c.split] ?? 0) + 1;
    if (pos < 5) top5[c.split] = (top5[c.split] ?? 0) + 1;
    else misses.push(`[${c.split}] ${c.q} -> ${ranked.slice(0, 3).join(', ')}`);
  }
  report('BM25 top-1', top1, []);
  report('BM25 top-5', top5, misses);
}

await (process.argv.includes('--lexical') ? lexicalMode() : modelMode());
process.exit(0);
