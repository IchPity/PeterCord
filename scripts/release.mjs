// Veröffentlicht eine neue Version von PeterCord:
//   npm run release 0.2.0      (oder: patch | minor | major)
// Das Skript setzt die Versionsnummer, committet, taggt und pusht. Den Rest (Installer bauen, signieren,
// GitHub-Release anlegen) erledigt die GitHub-Action in .github/workflows/release.yml.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const stop = (msg) => { console.error('\n✖ ' + msg + '\n'); process.exit(1); };
const run = (cmd) => { try { execSync(cmd, { stdio: 'inherit' }); } catch { stop('Dieser Schritt ist fehlgeschlagen: ' + cmd); } };
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const current = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const arg = process.argv[2];
if (!arg || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(arg)) {
  stop(`Welche Version? Beispiel: npm run release 0.2.0   (oder patch, minor, major). Aktuell ist ${current()}.`);
}
if (arg === current()) stop(`${arg} ist schon die aktuelle Version. Nimm eine höhere Nummer.`);
if (out('git status --porcelain')) stop('Es gibt noch nicht committete Änderungen. Erst committen (git add -A && git commit -m "…"), dann veröffentlichen.');
const branch = out('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') stop(`Du bist auf dem Branch "${branch}". Releases gehen nur von "main" aus.`);

run(`npm version ${arg} --no-git-tag-version`);
const version = current();
const tag = 'v' + version;
if (out(`git tag -l ${tag}`)) {
  run('git checkout -- package.json package-lock.json');
  stop(`Die Version ${version} gibt es schon. Nimm eine höhere Nummer.`);
}

run('git add package.json package-lock.json');
run(`git commit -m "Version ${version}"`);
run(`git tag ${tag}`);
run('git push origin main');
run(`git push origin ${tag}`);

console.log(`
✔ ${tag} ist unterwegs. GitHub baut jetzt den Installer (dauert rund 10 Minuten):
  https://github.com/IchPity/PeterCord/actions
Danach steht das Release hier, und alle installierten Apps aktualisieren sich beim nächsten Start:
  https://github.com/IchPity/PeterCord/releases/latest
`);
