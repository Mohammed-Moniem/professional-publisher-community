// Bootstrap before loading Playwright, so packaged renderer paths are portable.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
if(existsSync(join(root,'browsers')))process.env.PLAYWRIGHT_BROWSERS_PATH=join(root,'browsers');
await import('../dist/src/cli.js');
