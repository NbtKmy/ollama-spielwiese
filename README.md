# Ollama-Spielwiese

Mit diesem App kann man Ollamas API mit einigen Parametern und RAG mit localen Dokumenten ausprobieren.
Die Dokumente, die in diesem App gelesen werden, bleiben lokal in demselben Rechner. Das Vector-Store wird nach der Schliessung des Apps gelöscht.

## Requirements
Um mit diesem App zu spielen, braucht man [Ollama](https://ollama.com/) zuerst zu installieren.
Nach Installation ein Model für Chat-Funktion und ein Model für Embedding in Ollama holen.
Die Models sind [hier](https://ollama.com/search) aufgelistet.
Models für Embedding sind [hier](https://ollama.com/search?c=embedding)

Wenn man ein Model ausgesucht hat, kann man durch den folgenden Befehl im Terminal das Model herunterladen.

```
ollama pull [Modelname]
```

Ollama läuft i.d.R. immer, sobald man den PC/Mac angeschmissen hat und macht API-Schnittstelle offen, sobald Ollama aktiv bleibt.
Um zu überprüfen, ob Ollama aktiv ist, öffne die folgende Seite im Browser nach deiner Wahl:

```
http://localhost:11434/
```

Dann sollte eine Zeile "Ollama is running" angezeigt werden - Wenn es so ist, dann ist es alles Okay.




