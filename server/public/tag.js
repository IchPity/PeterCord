(function () {
  var t = ['Der Chat für Leute, die sowieso nur Quatsch schreiben.', 'Jetzt mit 100 % mehr Beweisfoto.', 'Kein Algorithmus, keine Werbung, nur ihr.',
    'Hier wird nichts gelöscht. Außer Würde.', 'Läuft auf Cloudflare und auf Hoffnung.', 'Gegründet auf rotem Teppich. Seriosität: 0 %.'];
  document.getElementById('tag').textContent = t[Math.floor(Math.random() * t.length)];
})();
