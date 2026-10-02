const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let n = 0;
for (const root of ['libs', 'apps']) {
  const base = path.join(__dirname, '..', root);
  if (!fs.existsSync(base)) continue;
  for (const pkg of fs.readdirSync(base)) {
    const src = path.join(base, pkg, 'src');
    for (const file of walk(src)) {
      if (/\.js\.map$/.test(file) || /\.d\.ts$/.test(file) || /\.js$/.test(file)) {
        fs.unlinkSync(file);
        n += 1;
      }
    }
  }
}
console.log(`clean-src-emit: removed ${n} files`);
