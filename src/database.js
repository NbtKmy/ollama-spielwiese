const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize the database
   */
  async init() {
    const SQL = await initSqlJs({
      locateFile: file => {
        // Electronの環境でWASMファイルのパスを正しく解決
        let wasmPath;

        // 開発環境
        if (fs.existsSync(path.join(__dirname, '../node_modules/sql.js/dist', file))) {
          wasmPath = path.join(__dirname, '../node_modules/sql.js/dist', file);
        }
        // パッケージ化された環境
        else if (process.resourcesPath) {
          wasmPath = path.join(process.resourcesPath, 'node_modules/sql.js/dist', file);
        }
        // フォールバック
        else {
          wasmPath = path.join(__dirname, '../node_modules/sql.js/dist', file);
        }

        console.log('[Database] Loading WASM from:', wasmPath);
        return wasmPath;
      }
    });

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
      console.log('[Database] Loaded existing database');

      // Ensure all tables exist (including FTS tables for existing databases)
      this.createTables();
      this.save();
    } else {
      this.db = new SQL.Database();
      console.log('[Database] Created new database');

      // Create tables
      this.createTables();
      this.save();
    }
  }

  /**
   * Create database tables
   */
  createTables() {
    // Documents table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source, embedding_model)
      )
    `);

    // Chunks table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        page INTEGER,
        content TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      )
    `);

    // Note: sql.js doesn't support FTS5, using LIKE-based search instead

    console.log('[Database] Tables created successfully');
  }

  /**
   * Save database to disk
   */
  save() {
    if (!this.db) return;

    const data = this.db.export();
    const buffer = Buffer.from(data);

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.dbPath, buffer);
    console.log('[Database] Saved to disk');
  }

  /**
   * Insert a document and return its ID
   * Returns an object: { id: number, existed: boolean }
   */
  insertDocument(source, embeddingModel) {
    try {
      this.db.run(
        'INSERT INTO documents (source, embedding_model) VALUES (?, ?)',
        [source, embeddingModel]
      );

      const result = this.db.exec('SELECT last_insert_rowid() as id');
      const docId = result[0].values[0][0];

      console.log(`[Database] Inserted document: ${source} (ID: ${docId})`);
      return { id: docId, existed: false };
    } catch (error) {
      // If document already exists (UNIQUE constraint), get its ID
      if (error.message.includes('UNIQUE constraint failed')) {
        const result = this.db.exec(
          'SELECT id FROM documents WHERE source = ? AND embedding_model = ?',
          [source, embeddingModel]
        );
        if (result.length > 0) {
          const docId = result[0].values[0][0];
          console.log(`[Database] Document already exists: ${source} (ID: ${docId})`);
          // 既存のチャンクを削除
          this.deleteChunksByDocumentId(docId);
          return { id: docId, existed: true };
        }
      }
      throw error;
    }
  }

  /**
   * Delete all chunks for a document ID
   */
  deleteChunksByDocumentId(documentId) {
    this.db.run('DELETE FROM chunks WHERE document_id = ?', [documentId]);
    console.log(`[Database] Deleted chunks for document ID: ${documentId}`);
  }

  /**
   * Insert a chunk and return its ID
   */
  insertChunk(documentId, chunkIndex, content, page = null) {
    this.db.run(
      'INSERT INTO chunks (document_id, chunk_index, page, content) VALUES (?, ?, ?, ?)',
      [documentId, chunkIndex, page, content]
    );

    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const chunkId = result[0].values[0][0];

    return chunkId;
  }

  /**
   * Get all stored sources grouped by filename
   */
  getStoredSources() {
    const result = this.db.exec(`
      SELECT
        source,
        GROUP_CONCAT(DISTINCT embedding_model) as models
      FROM documents
      GROUP BY source
    `);

    if (result.length === 0) {
      return [];
    }

    const columns = result[0].columns;
    const values = result[0].values;

    return values.map(row => ({
      source: row[columns.indexOf('source')],
      models: row[columns.indexOf('models')]?.split(',') || []
    }));
  }

  /**
   * Get document IDs by source path
   */
  getDocumentIdsBySource(sourcePath) {
    const result = this.db.exec(
      'SELECT id FROM documents WHERE source = ?',
      [sourcePath]
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map(row => row[0]);
  }

  /**
   * Get chunk IDs by document IDs
   */
  getChunkIdsByDocumentIds(documentIds) {
    if (documentIds.length === 0) {
      return [];
    }

    const placeholders = documentIds.map(() => '?').join(',');
    const result = this.db.exec(
      `SELECT id FROM chunks WHERE document_id IN (${placeholders})`,
      documentIds
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map(row => row[0]);
  }

  /**
   * Delete document by source path
   */
  deleteDocumentBySource(sourcePath) {
    this.db.run('DELETE FROM documents WHERE source = ?', [sourcePath]);
    console.log(`[Database] Deleted document: ${sourcePath}`);
  }

  /**
   * Get chunk content by chunk ID
   */
  getChunkById(chunkId) {
    const result = this.db.exec(
      `SELECT c.*, d.source
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       WHERE c.id = ?`,
      [chunkId]
    );

    if (result.length === 0) {
      return null;
    }

    const columns = result[0].columns;
    const row = result[0].values[0];

    return {
      id: row[columns.indexOf('id')],
      document_id: row[columns.indexOf('document_id')],
      chunk_index: row[columns.indexOf('chunk_index')],
      page: row[columns.indexOf('page')],
      content: row[columns.indexOf('content')],
      source: row[columns.indexOf('source')]
    };
  }

  /**
   * Full-text search using LIKE (sql.js doesn't support FTS5)
   * @param {string} query - Space-separated keywords
   * @param {number} limit - Maximum number of results
   * @returns {Array} Results with score property
   */
  fullTextSearch(query, limit = 5) {
    // Split query into keywords
    const keywords = query.toLowerCase().trim().split(/\s+/).filter(k => k.length > 0);

    console.log(`[Database] Full-text search with ${keywords.length} keywords:`, keywords);

    if (keywords.length === 0) {
      return [];
    }

    // Build LIKE conditions for each keyword
    const likeConditions = keywords.map(() => 'LOWER(c.content) LIKE ?').join(' OR ');
    const likeParams = keywords.map(k => `%${k}%`);

    const result = this.db.exec(
      `SELECT c.*, d.source, d.embedding_model
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       WHERE ${likeConditions}
       LIMIT ?`,
      [...likeParams, limit * 3] // Get more for scoring
    );

    if (result.length === 0) {
      console.log('[Database] No results found for query');
      return [];
    }

    console.log(`[Database] Found ${result[0].values.length} matching chunks before scoring`);

    const columns = result[0].columns;
    const rows = result[0].values.map(row => ({
      id: row[columns.indexOf('id')],
      document_id: row[columns.indexOf('document_id')],
      chunk_index: row[columns.indexOf('chunk_index')],
      page: row[columns.indexOf('page')],
      content: row[columns.indexOf('content')],
      source: row[columns.indexOf('source')],
      embedding_model: row[columns.indexOf('embedding_model')]
    }));

    // Calculate relevance score (keyword match count)
    const scoredRows = rows.map(row => {
      const contentLower = row.content.toLowerCase();
      let score = 0;

      for (const keyword of keywords) {
        // Escape special regex characters
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedKeyword, 'gi');
        const matches = (contentLower.match(regex) || []).length;
        score += matches;
      }

      return { ...row, score };
    });

    // Sort by score (highest first) and limit
    scoredRows.sort((a, b) => b.score - a.score);

    console.log(`[Database] Top ${Math.min(limit, scoredRows.length)} results:`,
      scoredRows.slice(0, limit).map(r => ({ source: r.source, score: r.score }))
    );

    return scoredRows.slice(0, limit);
  }

  /**
   * Close database
   */
  close() {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
      console.log('[Database] Closed');
    }
  }
}

module.exports = Database;
