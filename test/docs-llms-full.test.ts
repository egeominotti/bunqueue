import { describe, expect, test } from 'bun:test';
import {
  BUN_CLI_SERVER,
  SERVER_HEALTH_CHECK,
  SERVER_RUNTIMES,
  dockerRunCommand,
} from '../docs/src/data/firstJob';
import { inlineFirstJobCode, inlineRawCodeImports } from '../docs/src/lib/llms-full';

describe('inlineRawCodeImports', () => {
  test('replaces single-line and multiline Code components with the loaded source', async () => {
    const body = [
      "import { Code } from '@astrojs/starlight/components';",
      "import composeSource from '../../../../examples/demo/compose.yaml?raw';",
      "import scenarioSource from '../../../../examples/demo/scenario.ts?raw';",
      '',
      '<Code code={composeSource} lang="yaml" meta=\'title="compose.yaml"\' />',
      '<Code',
      '  code={scenarioSource}',
      '  lang="typescript"',
      '/>',
    ].join('\n');
    const sources: Record<string, string> = {
      '../../../../examples/demo/compose.yaml?raw': 'services:\n  app: {}\n',
      '../../../../examples/demo/scenario.ts?raw': "const result = 'PASS';\n",
    };

    const expanded = await inlineRawCodeImports(body, async (specifier) => sources[specifier]);

    expect(expanded).toContain('```yaml title="compose.yaml"\nservices:\n  app: {}\n```');
    expect(expanded).toContain("```typescript\nconst result = 'PASS';\n```");
    expect(expanded).not.toContain('?raw');
    expect(expanded).not.toContain('code={composeSource}');
    expect(expanded).toContain("import { Code } from '@astrojs/starlight/components';");
  });

  test('uses a longer fence when the imported source contains backticks', async () => {
    const body = 'import source from \'./sample.md?raw\';\n<Code code={source} lang="markdown" />';
    const expanded = await inlineRawCodeImports(body, () => '```ts\nconst value = 1;\n```\n');

    expect(expanded).toContain('````markdown\n```ts\nconst value = 1;\n```\n````');
  });

  test('fails closed when a raw import has no Code destination', async () => {
    const body = "import source from './sample.ts?raw';\n\nNothing renders it.";

    expect(inlineRawCodeImports(body, () => 'const hidden = true;')).rejects.toThrow(
      'source is not rendered by a Code component'
    );
  });

  test('does not execute raw imports or Code components shown inside a fenced example', async () => {
    const body = [
      '````mdx',
      '```ts',
      "import fakeSource from './fake.ts?raw';",
      '```',
      '<Code code={fakeSource} lang="typescript" />',
      '````',
      "import realSource from './real.ts?raw';",
      '<Code code={realSource} lang="typescript" />',
    ].join('\n');
    const loaded: string[] = [];
    const expanded = await inlineRawCodeImports(body, (specifier) => {
      loaded.push(specifier);
      return 'const real = true;';
    });

    expect(loaded).toEqual(['./real.ts?raw']);
    expect(expanded).toContain("import fakeSource from './fake.ts?raw';");
    expect(expanded).toContain('<Code code={fakeSource} lang="typescript" />');
    expect(expanded).toContain('```typescript\nconst real = true;\n```');
  });
});

describe('inlineFirstJobCode', () => {
  test('expands first-job components and shared server commands into fences', () => {
    const node = SERVER_RUNTIMES.find((runtime) => runtime.id === 'node');
    if (!node) throw new Error('Missing the Node.js first-job example');
    const body = [
      '1. **Start the server.**',
      '',
      '   <Code code={dockerRunCommand()} lang="bash" />',
      '',
      '   <Code code={SERVER_HEALTH_CHECK} lang="bash" />',
      '',
      '<FirstJobCode runtime="node" part="install" />',
      '',
      '<FirstJobCode runtime="node" part="files" />',
      '',
      '<FirstJobCode runtime="node" part="run" />',
      '',
      '<Code code={BUN_CLI_SERVER} lang="bash" />',
      '',
      'Or run it directly: <code>{BUN_CLI_SERVER}</code>.',
      '',
      "It prints <code>{'Processing: hello@example.com'}</code>.",
      '',
      '```mdx',
      '<FirstJobCode runtime="node" part="files" />',
      '```',
    ].join('\n');

    const expanded = inlineFirstJobCode(body);

    // Inside a list item, every line of the fence keeps the item's indentation.
    expect(expanded).toContain(
      `   \`\`\`bash\n${dockerRunCommand()
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n')}\n   \`\`\``
    );
    expect(expanded).toContain(`   \`\`\`bash\n   ${SERVER_HEALTH_CHECK}\n   \`\`\``);
    expect(expanded).toContain(`\`\`\`bash\n${node.install}\n\`\`\``);
    expect(expanded).toContain(`\`\`\`javascript title="jobs.mjs"\n${node.files[0].code}\n\`\`\``);
    expect(expanded).toContain(`\`\`\`bash\n${node.run}\n\`\`\``);
    expect(expanded).toContain(`\`\`\`bash\n${BUN_CLI_SERVER}\n\`\`\``);
    expect(expanded).toContain(`Or run it directly: \`${BUN_CLI_SERVER}\`.`);
    expect(expanded).toContain('It prints `Processing: hello@example.com`.');
    // An example shown inside a fence stays as written.
    expect(expanded).toContain('```mdx\n<FirstJobCode runtime="node" part="files" />\n```');
    expect(expanded.match(/<FirstJobCode/g)).toHaveLength(1);
    expect(expanded).not.toMatch(/<Code\b/);
    expect(expanded).not.toContain('<code>{');
  });

  test('fails closed on an unknown runtime', () => {
    expect(() => inlineFirstJobCode('<FirstJobCode runtime="cobol" part="files" />')).toThrow(
      /Unknown first-job runtime/
    );
  });
});
