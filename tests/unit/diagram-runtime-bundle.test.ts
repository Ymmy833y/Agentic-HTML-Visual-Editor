// @vitest-environment node
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

// Bundle the Mermaid loader the same way the view bundle does and list the inputs that reach the output.
async function listBundledInputs(): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints: ['webview/diagram/diagram-runtime.ts'],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return Object.values(result.metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => path.replaceAll('\\', '/')),
  );
}

describe('Mermaid bundle', () => {
  it('bundles DOMPurify from its own package instead of a copy prebuilt into Mermaid', async () => {
    const inputs = await listBundledInputs();

    expect(inputs.some((path) => path.startsWith('node_modules/dompurify/'))).toBe(true);
    expect(inputs.filter((path) => path.includes('mermaid.esm.min'))).toEqual([]);
  }, 60_000);
});
