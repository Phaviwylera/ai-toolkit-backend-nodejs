// PulseDial deployment bootstrap: restore the verified hosting-ready sources.
// The archive is generated from source files, with no dependencies or secrets.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const encoded = fs.readFileSync(path.join(__dirname, 'pulsedial-source.br.b64'), 'utf8').trim();
const files = JSON.parse(zlib.brotliDecompressSync(Buffer.from(encoded, 'base64')).toString('utf8'));
const allowed = new Set([
  'package.json', 'public/index.html', 'public/app.js', 'public/style.css',
  'public/favicon.svg', 'src/domain.js', 'src/server.js',
  'src/store.js', 'src/twilio.js'
]);
for (const [filename, content] of Object.entries(files)) {
  if (!allowed.has(filename) || typeof content !== 'string') throw new Error('Invalid payload entry');
  const dest = path.join(__dirname, filename);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, { mode: 0o644 });
}
if (Object.keys(files).length !== allowed.size) throw new Error('Incomplete payload');
console.log('PulseDial source restored (' + allowed.size + ' files).');
