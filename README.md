
# Turnierdashboard für GitHub Pages

## Enthalten
- `admin.html` — Gruppen anlegen, Zeiten und Platzierungen pflegen
- `client.html` — mobile Client-Ansicht
- `live.html` — horizontale Live-Ansicht
- `assets/app.js` — gemeinsame Logik
- `assets/style.css` — gemeinsames Design

## Daten-Repo
Im Ordner `storage-repo/` liegt das Ziel-Repo als Vorlage:
- `data.json`
- `README.md`

## So benutzt du es
1. Dieses Repo auf GitHub Pages veröffentlichen.
2. Ein zweites Repo für die Daten anlegen und `data.json` dort speichern.
3. In `admin.html`, `client.html` und `live.html` die Werte in `window.TOURNAMENT_CONFIG` anpassen:
   - `repoOwner`
   - `repoName`
   - `filePath`
   - `branch`
   - `rawDataUrl`
4. Für die Admin-Anmeldung einen GitHub Token mit Schreibrechten verwenden.
   - Für öffentliches Daten-Repo reicht oft `public_repo`
   - Für privates Daten-Repo ist `repo` nötig

## Wichtiger Hinweis
Ein Token im Browser ist keine echte Sicherheit. Für eine produktive Lösung wäre ein kleiner Server oder GitHub Actions sauberer. Für ein einfaches GitHub-Pages-Setup funktioniert diese Variante aber.
