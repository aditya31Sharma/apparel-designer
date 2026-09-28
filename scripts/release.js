/* Cut a release.
 *
 * The version in package.json is the one thing that has to be edited by hand.
 * Everything downstream of it (the update manifest, the tag, the release notes)
 * is derived here, because three places holding the same number is three places
 * to get it wrong, and the update manifest getting it wrong means every
 * installed copy either misses the update or downloads a tag that is not there.
 *
 *   npm version minor && npm run release
 *
 * Pushing is left to you on purpose. This writes and tags locally, then prints
 * the one command that makes it public.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifestPath = path.join(ROOT, 'app-version.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const version = pkg.version;
const tag = 'v' + version;

/* minShell only moves when a change reaches something an update cannot
 * replace: the main process, the preload, or a native dependency. Everything
 * else ships as a source update to copies already installed, so raising it
 * without cause forces a 150MB download on people for no reason.
 *
 * Listed file by file rather than as the electron/ directory, because most of
 * what is in there is test harnesses that never go into the build. Treating a
 * change to the suite as a change to the shell would send everybody to the
 * download page over a test they will never run. These are exactly the paths
 * electron-builder packages, and the two lists have to agree. */
const SHELL_FILES = [
  'electron/main.js', 'electron/preload.js',
  'electron/bgremove.js', 'electron/bgworker.js', 'electron/update.js'
];

const since = manifest.tag || 'HEAD';

/* Against the working tree rather than HEAD, so this answers correctly
 * whichever order the release is done in. */
const changedFiles = execSync(
  'git diff --name-only ' + since + ' -- ' + SHELL_FILES.join(' ') + ' 2>/dev/null || true',
  { cwd: ROOT }).toString().trim();

/* A new dependency is a shell change too, and it does not show up in any of
 * the files above. The version field is deliberately not consulted: bumping it
 * is what a release is, and treating that as a shell change would send every
 * installed copy to the download page on every release. */
function depsOf(json) {
  try {
    const p = JSON.parse(json);
    return JSON.stringify(p.dependencies || {});
  } catch (e) {
    return null;
  }
}

let depsChanged = false;
try {
  const before = depsOf(execSync('git show ' + since + ':package.json', { cwd: ROOT }).toString());
  const now = depsOf(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  depsChanged = before !== null && before !== now;
} catch (e) {
  // No such tag yet, which means there is nothing to compare against.
}

const shellTouched = [changedFiles, depsChanged ? 'package.json (dependencies)' : '']
  .filter(Boolean).join('\n');

const minShell = process.argv.includes('--shell') || shellTouched
  ? version
  : (manifest.minShell || '0.0.0');

const notes = process.argv.includes('--notes')
  ? process.argv[process.argv.indexOf('--notes') + 1]
  : execSync('git log -1 --pretty=%s', { cwd: ROOT }).toString().trim();

fs.writeFileSync(manifestPath,
  JSON.stringify({ version, minShell, tag, notes }, null, 2) + '\n');

console.log('app-version.json ->', JSON.stringify({ version, minShell, tag, notes }, null, 2));
if (shellTouched) {
  console.log('\nThe shell changed, so minShell moved to ' + version + ':');
  console.log(shellTouched.split('\n').map((f) => '  ' + f).join('\n'));
  console.log('Installed copies will be told to download a new build rather than');
  console.log('updating their source in place.');
}

console.log('\nNext:');
console.log('  git add -A && git commit -m "release ' + tag + '"');
console.log('  git tag ' + tag);
console.log('  git push origin main --tags        # this is what makes it public');
console.log('  npm run dist                       # then attach dist/*.dmg to the release');
