import ts from 'typescript';
import { resolve } from 'node:path';

/**
 * Fail the build unless the published entry declarations type-check the way a
 * strict Node consumer sees them: NodeNext, `skipLibCheck: false`, Node types
 * only and no DOM library. Any Bun global, `bun:*` module or DOM-only type that
 * reaches the public declaration graph therefore stops the build.
 */
export function assertPortableDeclarations(root: string, entries: string[]): void {
  const program = ts.createProgram(entries, {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    typeRoots: [resolve(root, 'node_modules/@types')],
  });
  const problems = ts
    .getPreEmitDiagnostics(program)
    .map(
      (diagnostic) =>
        `${diagnostic.file?.fileName ?? '<options>'}: ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          ' '
        )}`
    );
  for (const file of program.getSourceFiles()) {
    if (/[\\/](?:bun-types|@types[\\/]bun)[\\/]/.test(file.fileName))
      problems.push(`${file.fileName}: Bun type declarations reached the published graph`);
  }
  if (problems.length)
    throw new Error(`Published declarations are not portable:\n${problems.join('\n')}`);
}
