/**
 * Resolve k6.exe even when the current shell PATH was not refreshed after winget install.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function candidates() {
  const list = ['k6'];
  if (process.platform === 'win32') {
    list.push(
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'k6', 'k6.exe'),
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'k6',
        'k6.exe',
      ),
    );
  }
  return list;
}

function resolveK6() {
  for (const c of candidates()) {
    if (c === 'k6') {
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [
        'k6',
      ]);
      if (which.status === 0) return 'k6';
      continue;
    }
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const k6 = resolveK6();
if (!k6) {
  console.error(
    'k6 not found. Install from https://k6.io then open a NEW terminal, or ensure "C:\\Program Files\\k6" is on PATH.',
  );
  process.exit(1);
}

// Defaults: npm run test:k6
// Overrides via env (reliable on Windows npm): VUS=5 DURATION=10s REQUIRE_CREDIT=1 npm run test:k6
// Or pass k6 args after -- : npm run test:k6 -- run -e VUS=5 scripts/k6/sms-load.js
const args = process.argv.slice(2);
const script = args.length
  ? args
  : [
      'run',
      ...(process.env.VUS ? ['-e', `VUS=${process.env.VUS}`] : []),
      ...(process.env.DURATION
        ? ['-e', `DURATION=${process.env.DURATION}`]
        : []),
      ...(process.env.PRIORITY
        ? ['-e', `PRIORITY=${process.env.PRIORITY}`]
        : []),
      ...(process.env.REQUIRE_CREDIT
        ? ['-e', `REQUIRE_CREDIT=${process.env.REQUIRE_CREDIT}`]
        : []),
      path.join('scripts', 'k6', 'sms-load.js'),
    ];

const r = spawnSync(k6, script, { stdio: 'inherit', shell: false });
process.exit(r.status ?? 1);
