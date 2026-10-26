import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { build } from 'esbuild'

// Ink imports `react-devtools-core` inside its opt-in devtools module. That
// module only loads when the package is installed (ink probes it with
// `import.meta.resolve`), so the dependency is never needed at runtime; the
// stub keeps esbuild from failing on the unresolved import while preserving
// ink's lazy devtools path.
const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup: (build) => {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} }',
      loader: 'js',
    }))
  },
}

// Everything is bundled (ink, react, the ACP SDK, zod); only Node builtins stay
// external. `write: false` lets Node perform the write: esbuild's own process
// cannot write files in this sandbox.
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  plugins: [stubDevtools],
  write: false,
  logLevel: 'info',
}

const outputs = await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/cli.tsx'],
    outfile: 'dist/cli.js',
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
  }),
  // A second headless entry: `dist/acp.js` exposes the client without Ink so
  // scripts (e.g. scripts/smoke.mjs) can drive `dsh acp` directly.
  build({
    ...shared,
    entryPoints: ['src/acp.ts'],
    outfile: 'dist/acp.js',
  }),
])

for (const result of outputs) {
  for (const file of result.outputFiles) {
    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, file.contents)
    console.log(`wrote ${file.path} (${file.contents.length} bytes)`)
  }
}
