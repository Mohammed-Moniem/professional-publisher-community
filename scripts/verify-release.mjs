import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const path = resolve(process.argv[2] || '');
try {
  if (!process.argv[2]) throw Error('Usage: node scripts/verify-release.mjs /absolute/path/to/artifact');
  const checksum = (await readFile(path + '.sha256','utf8')).trim().split(/\s+/);
  if (checksum.length !== 2 || checksum[1] !== basename(path) || !/^[a-f0-9]{64}$/.test(checksum[0])) throw Error('Invalid checksum file.');
  const hash = createHash('sha256'); for await (const part of createReadStream(path)) hash.update(part);
  if (hash.digest('hex') !== checksum[0]) throw Error('Checksum mismatch. Do not install this artifact.');
  await promisify(execFile)('gh', ['attestation','verify',path,'--repo','Mohammed-Moniem/professional-publisher-community','--signer-workflow','Mohammed-Moniem/professional-publisher-community/.github/workflows/ci.yml'], { maxBuffer: 4_000_000 });
  console.log('Checksum and GitHub build provenance verified. This does not claim Apple notarization or Windows Authenticode signing.');
} catch (e) { console.error('Verification failed: ' + e.message); process.exitCode = 1; }
