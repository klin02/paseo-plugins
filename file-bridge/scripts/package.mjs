import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['scripts/build-assets.mjs'], { cwd: root, stdio: 'inherit' });
execFileSync('python3', ['-c', String.raw`
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
root=Path.cwd()
out=root/'dist'
out.mkdir(exist_ok=True)
archive=out/'file-bridge.zip'
files=[root/name for name in ['paseo-plugin.json','OVERVIEW.md','README.md','index.client.tsx','index.server.ts']]
for directory in ['client','server','shared','scripts']:
    files.extend(p for p in (root/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc')
with ZipFile(archive,'w',ZIP_DEFLATED) as bundle:
    for path in sorted(files): bundle.write(path,path.relative_to(root))
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(out/'file-bridge.zip.sha256').write_text(digest+'  file-bridge.zip\n')
print(str(archive)+' SHA256='+digest)
`], {cwd:root,stdio:'inherit'});
