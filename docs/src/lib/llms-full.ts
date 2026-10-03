import {
  BUN_CLI_SERVER,
  SERVER_HEALTH_CHECK,
  dockerRunCommand,
  firstJobRuntime,
} from '../data/firstJob';

export type RawSourceLoader = (specifier: string) => string | Promise<string>;

const RAW_IMPORT =
  /^import[ \t]+([A-Za-z_$][\w$]*)[ \t]+from[ \t]+(['"])([^'"]+\?raw[^'"]*)\2;?[ \t]*$/;

interface SourceImport {
  binding: string;
  end: number;
  specifier: string;
  start: number;
}

interface Range {
  end: number;
  start: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fencedSource(source: string, component: string): string {
  const language = /\blang\s*=\s*(['"])([^'"]+)\1/.exec(component)?.[2] ?? 'text';
  const meta = /\bmeta\s*=\s*(['"])(.*?)\1/s.exec(component)?.[2];
  const longestRun = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  const content = source.replace(/\n+$/, '');
  return `${fence}${language}${meta ? ` ${meta}` : ''}\n${content}\n${fence}`;
}

function inspectBody(body: string): { fences: Range[]; imports: SourceImport[] } {
  const fences: Range[] = [];
  const imports: SourceImport[] = [];
  const lines = body.split('\n');
  let activeFence: { length: number; marker: string; start: number } | null = null;
  let offset = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineEnd = offset + line.length;
    const opener = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opener) {
      if (!activeFence) {
        activeFence = { length: opener[1].length, marker: opener[1][0], start: offset };
      } else if (opener[1][0] === activeFence.marker && opener[1].length >= activeFence.length) {
        fences.push({ start: activeFence.start, end: lineEnd });
        activeFence = null;
      }
    } else if (!activeFence) {
      const match = RAW_IMPORT.exec(line);
      if (match) {
        imports.push({ start: offset, end: lineEnd, binding: match[1], specifier: match[3] });
      }
    }
    offset = lineEnd + (index < lines.length - 1 ? 1 : 0);
  }

  if (activeFence) fences.push({ start: activeFence.start, end: body.length });
  return { fences, imports };
}

/** Return only executable raw imports, excluding declarations shown in code fences. */
export function rawCodeSpecifiers(body: string): string[] {
  return inspectBody(body).imports.map(({ specifier }) => specifier);
}

const insideRange = (index: number, ranges: Range[]) =>
  ranges.some(({ start, end }) => index >= start && index < end);

/**
 * Expand Vite `?raw` imports rendered through Starlight's Code component.
 * The full-text endpoint must contain the source itself, not an MDX variable
 * that only the HTML build can resolve.
 */
export async function inlineRawCodeImports(
  body: string,
  loadSource: RawSourceLoader
): Promise<string> {
  const { fences, imports } = inspectBody(body);
  const edits: (Range & { value: string })[] = [];

  for (const { binding, end, specifier, start } of imports) {
    const componentPattern = new RegExp(
      `<Code\\b(?=[^>]*\\bcode\\s*=\\s*\\{${escapeRegExp(binding)}\\})[^>]*\\/\\s*>`,
      'g'
    );
    const components = [...body.matchAll(componentPattern)].filter(
      (match) => !insideRange(match.index, fences)
    );
    if (components.length === 0) {
      throw new Error(`Raw import ${binding} is not rendered by a Code component`);
    }

    const source = await loadSource(specifier);
    edits.push({ start, end, value: '' });
    for (const component of components) {
      edits.push({
        start: component.index,
        end: component.index + component[0].length,
        value: fencedSource(source, component[0]),
      });
    }
  }

  let expanded = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    expanded = expanded.slice(0, edit.start) + edit.value + expanded.slice(edit.end);
  }
  return expanded;
}

/** A Markdown fence for `code`, longer than any backtick run inside it. */
function fence(code: string, lang: string, title?: string): string {
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const marker = '`'.repeat(Math.max(3, longestRun + 1));
  return `${marker}${lang}${title ? ` title="${title}"` : ''}\n${code.replace(/\n+$/, '')}\n${marker}`;
}

/** Indent every line after the first, so a fence placed inside a list item stays in it. */
function indentContinuation(text: string, body: string, index: number): string {
  const lineStart = body.lastIndexOf('\n', index - 1) + 1;
  const indent = body.slice(lineStart, index);
  if (!/^[ \t]*$/.test(indent) || indent === '') return text;
  return text.replace(/\n(?=.)/g, `\n${indent}`).replace(/\n\n/g, `\n${indent}\n`);
}

/** Replace every match of `pattern` outside fenced examples. */
function replaceOutsideFences(
  body: string,
  pattern: RegExp,
  render: (match: RegExpExecArray) => string
): string {
  const { fences } = inspectBody(body);
  const edits: (Range & { value: string })[] = [];
  for (const match of body.matchAll(pattern)) {
    if (insideRange(match.index, fences)) continue;
    edits.push({
      start: match.index,
      end: match.index + match[0].length,
      value: indentContinuation(render(match as RegExpExecArray), body, match.index),
    });
  }
  let expanded = body;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    expanded = expanded.slice(0, edit.start) + edit.value + expanded.slice(edit.end);
  }
  return expanded;
}

const SHARED_COMMANDS: Record<string, () => string> = {
  BUN_CLI_SERVER: () => BUN_CLI_SERVER,
  SERVER_HEALTH_CHECK: () => SERVER_HEALTH_CHECK,
  'dockerRunCommand()': () => dockerRunCommand(),
};

/**
 * Expand the first-job examples (components/FirstJobCode.astro) and the shared server
 * commands from src/data/firstJob.ts into Markdown fences, so the full-text endpoint and
 * the Markdown twin of a page carry the code itself rather than a component only the
 * HTML build can render. An unknown runtime throws instead of dropping the example.
 */
export function inlineFirstJobCode(body: string): string {
  const withExamples = replaceOutsideFences(
    body,
    /<FirstJobCode\s+runtime="([\w-]+)"\s+part="(install|files|run)"\s*\/>/g,
    ([, runtime, part]) => {
      const example = firstJobRuntime(runtime);
      if (part === 'install') return fence(example.install, 'bash');
      if (part === 'run') return fence(example.run, 'bash');
      return example.files.map((file) => fence(file.code, file.lang, file.name)).join('\n\n');
    }
  );
  const withCommands = replaceOutsideFences(
    withExamples,
    /<Code\s+code=\{(BUN_CLI_SERVER|SERVER_HEALTH_CHECK|dockerRunCommand\(\))\}\s+lang="([\w-]+)"\s*\/>/g,
    ([, name, lang]) => fence(SHARED_COMMANDS[name](), lang)
  );
  const withInlineCommands = replaceOutsideFences(
    withCommands,
    /<code>\{(BUN_CLI_SERVER|SERVER_HEALTH_CHECK|dockerRunCommand\(\))\}<\/code>/g,
    ([, name]) => `\`${SHARED_COMMANDS[name]()}\``
  );
  // A string literal in inline code, such as the expected output line.
  return replaceOutsideFences(
    withInlineCommands,
    /<code>\{'([^'\\`]*)'\}<\/code>/g,
    ([, text]) => `\`${text}\``
  );
}
