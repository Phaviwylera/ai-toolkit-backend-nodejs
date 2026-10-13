// Build-only unpacker for Relay's static source assets (no third-party dependencies).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const src = path.join(__dirname, 'free-relay-archive.br.b64');
const files = JSON.parse(zlib.brotliDecompressSync(Buffer.from(fs.readFileSync(src, 'utf8').trim(), 'base64')).toString('utf8'));
const allowed = ['index.html', 'styles.css', 'app.js', 'icon.svg'];
if (Object.keys(files).length !== allowed.length || !allowed.every(k => typeof files[k] === 'string')) throw new Error('Invalid free Relay asset bundle');
const dir = path.join(__dirname, 'free-relay');
fs.mkdirSync(dir, { recursive: true });
for (const name of allowed) fs.writeFileSync(path.join(dir, name), files[name]);
console.log('Relay static site ready:', allowed.length, 'files');
