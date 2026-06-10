// Generiert src/version.ts aus der Version in package.json, damit serverInfo
// (Upstream-Server- und Downstream-Client-Konstruktor) nie von der Paketversion
// abdriftet. Wird vor build/test/typecheck/dev ausgeführt (siehe package.json),
// sodass die generierte Datei nie veraltet ist. Single Source of Truth bleibt
// package.json; der String wird beim Bundling fest einkompiliert — keine
// Laufzeit-Abhängigkeit auf einen relativen package.json-Pfad im dist/.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const out = `// AUTO-GENERIERT von scripts/gen-version.mjs — nicht von Hand editieren.
// Quelle der Wahrheit ist die Version in package.json.
export const VERSION = ${JSON.stringify(version)};
`;

writeFileSync(join(root, 'src', 'version.ts'), out);
