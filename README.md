# VOXELIA

Eine Voxel-Welt in Echtzeit-PBR: unendliches prozedurales Terrain, farbiges
Voxellicht, volumetrischer Himmel und vollständiges Survival-Spiel — in einer
einzigen HTML-Datei plus ES-Modulen, **ohne Abhängigkeiten und ohne eine
einzige Asset-Datei**.

Inspiriert von Minecraft, technisch aber eine eigenständige Engine: Deferred
PBR-Rendering, prozedural auf der GPU erzeugte Texturen, kaskadierte Schatten,
atmosphärische Streuung und Screen-Space-Reflexionen.

## Starten

Es gibt keinen Buildschritt. Einen beliebigen statischen Server im Ordner
`voxelia/` starten und die Seite öffnen:

```sh
cd voxelia
npx serve .          # oder: python3 -m http.server 8080
```

Voraussetzung ist ein Browser mit **WebGL2** (Chrome, Edge, Firefox, Safari 15+)
und aktivierter Hardwarebeschleunigung. Ein `file://`-Aufruf funktioniert nicht,
weil ES-Module und Web-Worker eine echte Herkunft benötigen.

## Steuerung

| Taste | Wirkung |
|---|---|
| `W A S D` | Bewegen |
| Maus | Umsehen (Klick fängt den Zeiger) |
| Leertaste | Springen · doppelt tippen: Fliegen im Kreativmodus |
| `Umschalt` | Schleichen (schützt vor Abstürzen) |
| `Strg` | Sprinten |
| Linksklick | Abbauen / Angreifen |
| Rechtsklick | Platzieren / Benutzen |
| Mausrad, `1`–`9` | Schnellleiste |
| `E` | Inventar |
| `Q` | Gegenstand wegwerfen |
| `F5` | Perspektive wechseln |
| `F3` | Technische Anzeige |
| `Esc` | Pause |

## Technik

### Rendern

Deferred PBR über vier Rendertargets (Albedo + Metallic, Weltnormale +
Rauheit, gebackenes Voxellicht + Himmelslicht, AO + Materialflags + Emission)
mit `DEPTH_COMPONENT32F` als abtastbarer Tiefe.

* **Texturen** entstehen beim Start auf der Grafikkarte: 271 Materialien über
  92 handgeschriebene Prozeduren, je bis 1024 px, als Albedo, Normale und
  Metallic/Rauheit/AO/Emission. Normalen werden analytisch aus dem jeweiligen
  Höhenfeld abgeleitet, nicht aus der Helligkeit gefälscht.
* **Licht** ist farbig: pro Voxel je 4 Bit für Rot, Grün, Blau und Himmel. Eine
  rote Fackel neben einer blauen Lampe ergibt korrektes Magenta.
* **Schatten**: kaskadierte Schattenkarten, texelgenau eingerastet, damit
  Kanten beim Gehen nicht flimmern.
* **Himmel**: echte Rayleigh-Mie-Streuung mit vorberechneten Transmissions- und
  Mehrfachstreu-Tabellen, Sonnenscheibe mit Randverdunkelung, Mond mit Phasen
  und Kratern, 2000 Sterne, Polarlicht, zweilagige volumetrische Wolken.
* **Wasser**: Gerstner-Wellen, Screen-Space-Reflexionen mit Himmels-Rückfall,
  tiefenabhängige Absorption, Schaum, Kaustik, Unterwasser-Überlagerung.
* **Post**: TAA mit Varianz-Clipping im YCoCg-Raum, Bewegungsunschärfe,
  Tiefenschärfe, Bloom, automatische Belichtung, ACES, Farbgrading, Filmkorn.

### Welt

3D-Dichtefeld statt Höhenkarte, daher echte Überhänge und Klippen. Klima aus
Kontinentalität, Erosion und Gebirgigkeit über Spline-Kurven; Käsehöhlen,
Spaghettihöhlen, Schluchten und Aquifere; Erzbänder mit Deepslate-Varianten;
44 Biome. Welthöhe −64 bis 320.

Generierung und Vernetzung laufen in Modul-Workern. Der Mesher arbeitet mit
Greedy-Meshing, Vertex-AO, weichem Licht und Biom-Übergängen und erzeugt ein
32-Byte-Vertexformat.

### Spiel

278 Blöcke, über 400 Gegenstände, mehr als 130 Rezepte, 22 Kreaturen mit
A*-Wegfindung und prioritätsbasiertem Verhalten, Hunger und Erschöpfung,
Rüstungsformel, Erfahrungskurve, Tag-Nacht-Zyklus mit Wetterautomat.

Dazu Nether-Dimension mit Portalen, vollständige Redstone-Logik, 26
Statuseffekte, Brauen, 27 Verzauberungen mit Amboss, Landwirtschaft mit
Züchtung, Dorfbewohner mit zwölf Berufen und Handel sowie ein dreiphasiger
Bosskampf.

Sämtliche Klänge werden mit der Web Audio API synthetisiert — materialabhängige
Schritte und Schläge, Kreaturenlaute, Wetter, dazu generative Musik in vier
Stimmungen. Welten liegen in IndexedDB; gespeichert werden nur die Abweichungen
vom Generator.

## Werkzeuge

Alle Prüfungen laufen headless und ohne GPU (Chromium mit SwiftShader):

```sh
node tools/check-imports.mjs     # jedes Import/Export-Paar
node tools/check-data.mjs        # Blöcke, Materialien, Biome, Rezepte
node tools/check-ui-classes.mjs  # jede CSS-Klasse, die die UI ausgibt
node tools/lint-glsl.mjs         # reservierte Wörter in eingebettetem GLSL
node tools/test-world.mjs        # Generator, Licht und Mesher mit Querschnitt
node tools/content-test.mjs      # Redstone, Landwirtschaft, Effekte, Portale
node tools/playtest.mjs --out …  # echter Durchspieldurchgang mit Screenshots
node tools/ui-tour.mjs --out …   # alle Bildschirme
node tools/smoke.mjs --out …     # Startlauf mit Konsolen- und Shaderprüfung
```

Eine Warnung an künftige Mitlesende: Unter SwiftShader dauert ein Bild rund
zwanzig Sekunden statt sechzehn Millisekunden. Dadurch kippt jede Zeitannahme —
Streaming-Budgets, CSS-Überblendungen, Nachholticks, Partikellebensdauer. Die
Werkzeuge messen deshalb den tatsächlichen Bildinhalt, statt Erfolg
anzunehmen, und `content-test.mjs` umgeht das Rendern vollständig.

## Aufbau

```
voxelia/
  index.html              Spielhülle mit Boot-Splash und Fehlerabfang
  ARCHITECTURE.md         verbindlicher Modulvertrag
  src/core/               WebGL2-Wrapper, Mathematik, Eingabe, Einstellungen
  src/world/              Blöcke, Biome, Generator, Chunks, Licht, Mesher
  src/render/             Texturen, G-Buffer, Schatten, Himmel, Wasser, Post
  src/game/               Spieler, Physik, Inventar, Kampf, Mobs, Inhalte
  src/ui/                 HUD, Menüs, Inventar, Stationen, Stilsystem
  tools/                  Prüf- und Aufnahmewerkzeuge
```

`ARCHITECTURE.md` beschreibt die verbindlichen Verträge: Vertexformat,
G-Buffer-Belegung, UBO-Layouts, feste Textureinheiten und die
GLSL-Include-Bausteine. Wer die Engine erweitert, sollte dort beginnen.
