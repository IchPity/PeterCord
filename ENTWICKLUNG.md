# PeterCord entwickeln und betreiben

Für Peter (und alle, die mitbauen wollen). Die Anleitung für Nutzer steht in der [README](README.md).

## Aufbau

| Ordner | Was dort liegt |
| --- | --- |
| `app/` | Die Oberfläche: schlichtes HTML, CSS und JavaScript ohne Framework und ohne Build-Schritt. |
| `src-tauri/` | Die Desktop-Hülle ([Tauri](https://tauri.app), Rust): Fenster, Tray-Symbol, Benachrichtigungen, Autostart, Auto-Update. |
| `server/` | Der Server: ein Cloudflare Worker mit einem Durable Object. Dort liegen Datenbank (SQLite) und alle WebSocket-Verbindungen. |
| `scripts/` | Helfer zum Veröffentlichen und zum Verwalten der Konten. |
| `.github/workflows/release.yml` | Baut bei jedem Versions-Tag den Installer und legt das GitHub-Release an. |

Warum so sparsam? Tauri nutzt das in Windows eingebaute WebView2 statt einen eigenen Browser mitzuliefern
(Installer ≈ 2 MB). Die App wartet im Leerlauf nur auf Nachrichten und schickt alle 25 Sekunden einen Herzschlag.
Der Server schläft, solange niemand etwas tut (WebSocket-Hibernation), und passt in Cloudflares Gratis-Kontingent.

Sprache und Bildschirmübertragung laufen über WebRTC direkt zwischen den Geräten; der Server vermittelt nur.

## Ein Update veröffentlichen

```
git add -A
git commit -m "Was sich geändert hat"
npm run release 0.2.0
```

`npm run release` setzt die Versionsnummer (in `package.json`, die einzige Stelle), taggt und pusht.
GitHub baut dann in rund 10 Minuten den Installer und veröffentlicht ihn. Statt einer Nummer gehen auch
`patch`, `minor` oder `major`. Alle installierten Apps holen sich die neue Version beim nächsten Start von selbst
(sie fragen `releases/latest/download/latest.json` ab).

Hat sich etwas im Ordner `server/` geändert, zusätzlich den Server ausrollen – am besten **vor** dem Release:

```
npm run deploy:server
```

Das aktualisiert auch die Web-Version unter <https://petercord.hakwt.workers.dev>, denn der Worker liefert den Ordner `app/` mit aus.

## Zwei Dateien, die du sichern musst

Beide liegen in `C:\Users\<du>\.tauri\` und **nicht** im Repository:

- `petercord.key` – der Schlüssel, mit dem Updates signiert werden. Er ist als Secret `TAURI_SIGNING_PRIVATE_KEY`
  bei GitHub hinterlegt. Geht er verloren, können bereits installierte Apps keine Updates mehr annehmen
  (alle müssten einmal von Hand neu installieren). Kopier ihn an einen sicheren Ort.
- `petercord-admin.key` – der Schlüssel für die Verwaltungsbefehle unten (`npm run nutzer` usw.). Er ist als Secret `ADMIN_KEY` beim Worker hinterlegt.
  Einen neuen einrichten: eine lange Zufallszeichenfolge in die Datei schreiben und im Ordner `server/`
  `npx wrangler secret put ADMIN_KEY` ausführen.

## Konten verwalten

```
npm run nutzer                                    # alle Konten auflisten
npm run passwort -- benutzername neues-passwort   # Passwort neu setzen, wenn es jemand vergessen hat
npm run konto-loeschen -- benutzername            # ein Konto entfernen (zum Beispiel einen Fremden)
```

Ein neues Passwort meldet das Konto auf allen Geräten ab; danach kann sich die Person damit anmelden und es
in den Einstellungen selbst ändern. Von einem gelöschten Konto bleiben nur die Nachrichten stehen, als „Gelöschtes Konto“.

## Optionale Server-Einstellungen

Alle werden im Ordner `server/` mit `npx wrangler secret put NAME` gesetzt:

- **`REGISTER_CODE`** – Zugangscode für neue Konten. Ohne ihn kann sich jeder registrieren, der die Server-Adresse
  kennt (sie steht in diesem öffentlichen Repository). Schreiben kann man Fremden trotzdem nicht: Dafür braucht es
  eine angenommene Freundschaftsanfrage oder einen Einladungscode. Mit gesetztem Code fragt die App beim
  Registrieren danach. Wer sich angemeldet hat, zeigt `npm run nutzer`.
- **`TURN_KEY_ID` und `TURN_KEY_TOKEN`** – macht Anrufe auch hinter strengen Firewalls möglich. Im
  [Cloudflare-Dashboard](https://dash.cloudflare.com/?to=/:account/calls) unter *Realtime → TURN Server* einen Schlüssel
  anlegen und „Turn Token ID“ sowie „API Token“ als diese beiden Secrets hinterlegen. Ohne sie nutzt PeterCord nur
  STUN, was in den meisten Heimnetzen reicht. (Cloudflare schenkt 1.000 GB TURN-Verkehr pro Monat.)

## Lokal entwickeln

Voraussetzungen: [Node.js](https://nodejs.org), [Rust](https://rustup.rs) und die „Desktopentwicklung mit C++“ aus den
Visual Studio Build Tools.

```
npm install
npm run dev          # startet die Desktop-App gegen den echten Server
```

Server lokal testen:

```
cd server
npm install
npx wrangler dev --port 8799
```

Dann im Browser <http://127.0.0.1:8799> öffnen – oder in der App auf dem Anmeldebildschirm unter
*Anderen Server verwenden* diese Adresse eintragen. Die lokale Datenbank liegt in `server/.wrangler/` und hat nichts
mit der echten zu tun.

Einen Installer von Hand bauen (braucht den Signier-Schlüssel als Umgebungsvariable):

```
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $HOME\.tauri\petercord.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run build
```

## Eigenen Server aufsetzen

1. Bei Cloudflare anmelden: `npx wrangler login`
2. `npm run deploy:server` – am Ende steht die Adresse des Workers.
3. Diese Adresse in `app/js/config.js` eintragen und in `src-tauri/tauri.conf.json` unter `plugins.updater.endpoints`
   das eigene Repository einsetzen.
4. Eigenen Signier-Schlüssel erzeugen: `npx tauri signer generate -w ~/.tauri/petercord.key`, den öffentlichen Teil
   (`.key.pub`) als `pubkey` in `tauri.conf.json` eintragen und den privaten als GitHub-Secret
   `TAURI_SIGNING_PRIVATE_KEY` hinterlegen.

## Grenzen, die man kennen sollte

- Sprachkanäle sind als direktes Netz zwischen allen Teilnehmern gebaut. Bis etwa acht Leute läuft das rund,
  bei zwölf ist Schluss.
- Dateien: 10 MB pro Datei, 500 MB pro Konto.
- Der Installer ist nicht mit einem gekauften Zertifikat signiert, deshalb warnt Windows SmartScreen beim ersten Start.
