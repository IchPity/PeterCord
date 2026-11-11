// Verwaltung für den Betreiber des PeterCord-Servers:
//   npm run nutzer                                     – alle Konten auflisten
//   npm run passwort -- <benutzername> <neues-passwort> – Passwort neu setzen (wenn es jemand vergessen hat)
//   npm run konto-loeschen -- <benutzername>            – ein Konto entfernen
// Braucht den Admin-Schlüssel. Er liegt nur auf Peters Rechner (~/.tauri/petercord-admin.key)
// und als Secret ADMIN_KEY beim Server – nie im Repository.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const stop = (msg) => { console.error('\n✖ ' + msg + '\n'); process.exit(1); };
const [command, username, password] = process.argv.slice(2);

const config = readFileSync(new URL('../app/js/config.js', import.meta.url), 'utf8');
const server = process.env.PETERCORD_SERVER || config.match(/DEFAULT_SERVER = '([^']+)'/)[1];

let key = process.env.PETERCORD_ADMIN_KEY;
if (!key) {
  const file = join(homedir(), '.tauri', 'petercord-admin.key');
  try { key = readFileSync(file, 'utf8').trim(); } catch { stop(`Der Admin-Schlüssel fehlt (${file}). Wie man einen neuen einrichtet, steht in ENTWICKLUNG.md.`); }
}

async function call(action, body = {}) {
  const res = await fetch(`${server}/api/admin/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  }).catch(() => stop('Der Server ist nicht erreichbar: ' + server));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.err) stop(data.err || 'Serverfehler ' + res.status);
  return data;
}

if (command === 'nutzer') {
  const { users } = await call('users');
  if (!users.length) console.log('\nNoch keine Konten.\n');
  else {
    const day = new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' });
    console.table(users.map((u) => ({
      Benutzername: u.username,
      Anzeigename: u.display,
      Erstellt: day.format(u.created),
      Nachrichten: u.messages,
      Gruppen: u.groups,
      'Dateien (MB)': Math.round((u.bytes / 1048576) * 10) / 10,
      Online: u.online ? 'ja' : '',
    })));
  }
} else if (command === 'passwort') {
  if (!username || !password) stop('So geht es: npm run passwort -- <benutzername> <neues-passwort>');
  await call('password', { username, password });
  console.log(`\n✔ Neues Passwort für "${username}" gesetzt. Alle Geräte dieses Kontos wurden abgemeldet.\n`);
} else if (command === 'loeschen') {
  if (!username) stop('So geht es: npm run konto-loeschen -- <benutzername>');
  await call('delete', { username });
  console.log(`\n✔ Das Konto "${username}" wurde gelöscht. Seine Nachrichten zeigen nur noch „Gelöschtes Konto“.\n`);
} else {
  stop('Unbekannter Befehl. Möglich sind: npm run nutzer | npm run passwort -- <name> <passwort> | npm run konto-loeschen -- <name>');
}
