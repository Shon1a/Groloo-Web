/* The ffmpeg.wasm core is 32 MB and does NOT belong in the repository.
 *
 * It is a build artefact of a dependency, identical for everyone, and committing it would
 * add 32 MB to every clone for a file npm already fetches. This copies it out of
 * node_modules into public/ at install/build time instead, and public/ffmpeg is gitignored.
 *
 * The ESM build specifically: ffmpeg.wasm loads its core with a dynamic `import()`, so the
 * UMD one cannot be used from a module context. */
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
const to = join(root, 'public', 'ffmpeg');

if (!existsSync(from)) {
  console.log('copy-ffmpeg: @ffmpeg/core not installed — skipping (the Dolby path will be unavailable)');
  process.exit(0);
}
await mkdir(to, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await copyFile(join(from, f), join(to, f));
}
console.log('copy-ffmpeg: core copied to public/ffmpeg');
