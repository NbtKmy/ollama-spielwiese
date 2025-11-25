# Ollama-Spielwiese

Eine Desktop-Anwendung zum Experimentieren mit Ollamas API, verschiedenen LLM-Parametern und RAG (Retrieval-Augmented Generation) mit lokalen Dokumenten.

## Hauptfunktionen

### Chat-Funktionen
- Interaktive Konversation mit lokalen LLMs über Ollama
- Markdown-Rendering für formatierte Antworten
- Chat-Verlauf exportieren
- Anpassbare Systemprompte
- Feinabstimmbare Modellparameter (Temperature, Top P, Top K, Seed)
- Typing-Indikatoren für bessere UX

### RAG (Retrieval-Augmented Generation)
Die App bietet drei verschiedene RAG-Modi für dokumentbasierte Suche:

#### 1. Embedding RAG (Vektor-Suche)
- Verwendet Vektor-Embeddings für semantische Ähnlichkeitssuche
- Integriert FAISS für effiziente Vektorsuche
- Ideal für konzeptbasierte Abfragen

#### 2. Full-text RAG (Schlüsselwortsuche)
- Keyword-basierte Suche mit LIKE-Abfragen
- Intelligente Query-Umschreibung mit LLM
- Berücksichtigt Chat-Kontext für bessere Keyword-Extraktion
- Scoring basierend auf Keyword-Häufigkeit
- Automatische Deduplizierung und Filterung kurzer Keywords

#### 3. Hybrid RAG (Kombiniert)
- Kombiniert Embedding-Suche und Full-text-Suche
- Nutzt die Vorteile beider Ansätze
- Beste Ergebnisse für komplexe Abfragen

#### 4. GraphRAG (Graphbasierte Analyse)
- Nutzt Knowledge Graph-Techniken für kontextbewusste Dokumentensuche
- Extrahiert Entitäten und ihre Beziehungen aus Dokumenten
- Verwendet PageRank-Algorithmus zur Bewertung der Chunk-Wichtigkeit
- Kombiniert strukturelle Graphanalyse mit semantischer Vektorsuche

**GraphRAG Ablauf:**
1. **Query-Analyse**: LLM extrahiert relevante Keywords aus der Benutzeranfrage
2. **Keyword-Matching**: Findet Chunks, die die extrahierten Keywords enthalten
3. **Graph-Konstruktion**:
   - Baut einen Graphen, wo Chunks Knoten und gemeinsame Entitäten Kanten sind
   - Gewichtet Kanten basierend auf der Anzahl gemeinsamer Entitäten
4. **PageRank-Ranking**: Bewertet Chunks nach ihrer strukturellen Wichtigkeit im Graphen
5. **Vektoren-Reranking**: Verfeinert das Ranking mit semantischer Ähnlichkeitssuche
6. **Kontext-Generierung**: Reichert die Top-Chunks mit ihren Graph-Nachbarn an

### Dokumentenverwaltung
- PDF-Upload und automatische Verarbeitung
- Chunks werden persistent in SQLite-Datenbank gespeichert
- Dokumente bleiben zwischen App-Neustarts erhalten
- Verwaltung mehrerer Dokumente gleichzeitig
- Einfaches Löschen von Dokumenten
- Überschreiben von Dokumenten bei erneutem Upload

### Datenschutz
- Alle Dokumente bleiben lokal auf demselben Rechner
- Keine Daten werden an externe Server gesendet
- Volle Kontrolle über eigene Daten

## Requirements

Um mit diesem App zu spielen, braucht man:

1. [Ollama](https://ollama.com/) installiert
2. Mindestens ein Chat-Model für die Konversation
3. Ein Embedding-Model für RAG-Funktionen

### Model-Installation

Die verfügbaren Models sind hier aufgelistet:
- Chat-Models: [https://ollama.com/search](https://ollama.com/search)
- Embedding-Models: [https://ollama.com/search?c=embedding](https://ollama.com/search?c=embedding)

Wenn man ein Model ausgesucht hat, kann man es durch den folgenden Befehl im Terminal herunterladen:

```bash
ollama pull [Modelname]
```

Beispiele:
```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

### Ollama-Verfügbarkeit prüfen

Ollama läuft i.d.R. immer, sobald man den PC/Mac angeschmissen hat und macht die API-Schnittstelle offen.
Um zu überprüfen, ob Ollama aktiv ist, öffne die folgende Seite im Browser:

```
http://localhost:11434/
```

Dann sollte die Zeile "Ollama is running" angezeigt werden.

## Installation und Start

```bash
# Dependencies installieren
npm install

# App starten (Development)
npm start

# App bauen (Production)
npm run build
```

## Verwendung

1. **Model auswählen**: Wähle ein Chat-Model und ein Embedding-Model aus den Dropdown-Menüs
2. **Parameter anpassen**: Optional kannst du Temperature, Top P, Top K und Seed anpassen
3. **Systemprompt setzen**: Optional kannst du einen Systemprompt definieren
4. **PDF hochladen**: Klicke auf "Load PDF for RAG" um Dokumente für RAG zu laden
5. **RAG aktivieren**: Aktiviere "Apply RAG" Checkbox und wähle einen RAG-Modus
6. **Chatten**: Stelle Fragen im Chat - bei aktiviertem RAG werden relevante Dokumente-Chunks verwendet

## Technische Details

- **Framework**: Electron
- **Datenbank**: SQLite (sql.js)
- **Vektorsuche**: FAISS (via faiss-node)
- **PDF-Verarbeitung**: pdf-parse
- **Styling**: TailwindCSS
- **LLM-Integration**: Ollama API

## Architektur

- `src/main.js`: Electron Main Process
- `src/preload.js`: Preload-Skript für IPC-Kommunikation, RAG-Logik, Vektorsuche
- `src/renderer.js`: Frontend-Logik, UI-Interaktionen
- `src/database.js`: SQLite-Datenbank-Management, Full-text-Suche
- `public/index.html`: UI-Struktur
- `public/style.css`: Styling

## Bekannte Einschränkungen

- sql.js unterstützt kein FTS5 (Full-Text Search 5), daher wird LIKE-basierte Suche verwendet
- better-sqlite3 ist aufgrund von Node.js v25 Kompatibilitätsproblemen nicht verfügbar




