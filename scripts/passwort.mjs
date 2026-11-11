// Setzt das Passwort eines Kontos neu, wenn es jemand vergessen hat:
//   npm run passwort -- <benutzername> <neues-passwort>
// Braucht den Admin-Schlüssel. Er liegt nur auf Peters Rechner (~/.tauri/petercord-admin.key)
// und als Secret ADMIN_KEY beim Server – nie im Repository.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const stop = (msg) => { console.error('\n✖ ' + msg + '\n'); process.exit(1); };

const [username, password] = process.argv.slice(2);
if (!username || !password) stop('So geht es: npm run passwort -- <benutzername> <neues-passwort>');

const config = readFileSync(new URL('../app/js/config.js', import.meta.url), 'utf8');
const server = process.env.PETERCORD_SERVER || config.match(/DEFAULT_SERVER = '([^']+)'/)[1];

let key = process.env.PETERCORD_ADMIN_KEY;
if (!key) {
  const file = join(homedir(), '.tauri', 'petercord-admin.key');
  try { key = readFileSync(file, 'utf8').trim(); } catch { stop(`Der Admin-Schlüssel fehlt (${file}). Wie man einen neuen einrichtet, steht in ENTWICKLUNG.md.`); }
}

const res = await fetch(server + '/api/admin/password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
  body: JSON.stringify({ username, password }),
}).catch(() => stop('Der Server ist nicht erreichbar: ' + server));
const data = await res.json().catch(() => ({}));
if (!res.ok || data.err) stop(data.err || 'Serverfehler ' + res.status);
console.log(`\n✔ Neues Passwort für "${username}" gesetzt. Alle Geräte dieses Kontos wurden abgemeldet.\n`);
