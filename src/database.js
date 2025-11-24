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

    // GraphRAG: Entities table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name, type)
      )
    `);

    // GraphRAG: Relationships table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_entity_id INTEGER NOT NULL,
        target_entity_id INTEGER NOT NULL,
        relationship_type TEXT NOT NULL,
        description TEXT,
        weight REAL DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        UNIQUE(source_entity_id, target_entity_id, relationship_type)
      )
    `);

    // GraphRAG: Entity mentions table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS entity_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        chunk_id INTEGER NOT NULL,
        mention_text TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
        UNIQUE(entity_id, chunk_id)
      )
    `);

    // GraphRAG: Relationship mentions table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS relationship_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relationship_id INTEGER NOT NULL,
        chunk_id INTEGER NOT NULL,
        context TEXT,
        confidence REAL DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE CASCADE,
        FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
        UNIQUE(relationship_id, chunk_id)
      )
    `);

    // GraphRAG: Entity embeddings table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS entity_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id INTEGER NOT NULL,
        embedding_model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
        UNIQUE(entity_id, embedding_model)
      )
    `);

    // Create indexes for better query performance
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_entity_mentions_chunk ON entity_mentions(chunk_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_relationship_mentions_chunk ON relationship_mentions(chunk_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_relationship_mentions_rel ON relationship_mentions(relationship_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id)`);

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
   * Get all chunks for a document ID
   * @param {number} documentId - Document ID
   * @returns {Array} Array of chunk objects
   */
  getChunksByDocumentId(documentId) {
    const result = this.db.exec(
      `SELECT c.*, d.source
       FROM chunks c
       JOIN documents d ON c.document_id = d.id
       WHERE c.document_id = ?
       ORDER BY c.chunk_index`,
      [documentId]
    );

    if (result.length === 0) {
      return [];
    }

    const columns = result[0].columns;
    return result[0].values.map(row => ({
      id: row[columns.indexOf('id')],
      document_id: row[columns.indexOf('document_id')],
      chunk_index: row[columns.indexOf('chunk_index')],
      page: row[columns.indexOf('page')],
      content: row[columns.indexOf('content')],
      source: row[columns.indexOf('source')]
    }));
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

  // ==========================================
  // GraphRAG Methods
  // ==========================================

  /**
   * Insert or get existing entity
   * @param {string} name - Entity name
   * @param {string} type - Entity type (PERSON, ORGANIZATION, LOCATION, CONCEPT, etc.)
   * @param {string} description - Optional description
   * @returns {number} Entity ID
   */
  insertEntity(name, type, description = null) {
    try {
      this.db.run(
        'INSERT INTO entities (name, type, description) VALUES (?, ?, ?)',
        [name, type, description]
      );

      const result = this.db.exec('SELECT last_insert_rowid() as id');
      const entityId = result[0].values[0][0];

      console.log(`[Database] Inserted entity: ${name} (${type}) - ID: ${entityId}`);
      return entityId;
    } catch (error) {
      // If entity already exists (UNIQUE constraint), get its ID
      if (error.message.includes('UNIQUE constraint failed')) {
        const result = this.db.exec(
          'SELECT id FROM entities WHERE name = ? AND type = ?',
          [name, type]
        );
        if (result.length > 0) {
          const entityId = result[0].values[0][0];
          console.log(`[Database] Entity already exists: ${name} (${type}) - ID: ${entityId}`);

          // Update description if provided
          if (description) {
            this.db.run(
              'UPDATE entities SET description = ? WHERE id = ?',
              [description, entityId]
            );
          }

          return entityId;
        }
      }
      throw error;
    }
  }

  /**
   * Insert or get existing relationship
   * @param {number} sourceEntityId - Source entity ID
   * @param {number} targetEntityId - Target entity ID
   * @param {string} relationshipType - Type of relationship
   * @param {string} description - Optional description
   * @param {number} weight - Relationship weight (default: 1.0)
   * @returns {number} Relationship ID
   */
  insertRelationship(sourceEntityId, targetEntityId, relationshipType, description = null, weight = 1.0) {
    try {
      this.db.run(
        'INSERT INTO relationships (source_entity_id, target_entity_id, relationship_type, description, weight) VALUES (?, ?, ?, ?, ?)',
        [sourceEntityId, targetEntityId, relationshipType, description, weight]
      );

      const result = this.db.exec('SELECT last_insert_rowid() as id');
      const relationshipId = result[0].values[0][0];

      console.log(`[Database] Inserted relationship: ${sourceEntityId} -> ${targetEntityId} (${relationshipType}) - ID: ${relationshipId}`);
      return relationshipId;
    } catch (error) {
      // If relationship already exists (UNIQUE constraint), get its ID
      if (error.message.includes('UNIQUE constraint failed')) {
        const result = this.db.exec(
          'SELECT id FROM relationships WHERE source_entity_id = ? AND target_entity_id = ? AND relationship_type = ?',
          [sourceEntityId, targetEntityId, relationshipType]
        );
        if (result.length > 0) {
          const relationshipId = result[0].values[0][0];
          console.log(`[Database] Relationship already exists - ID: ${relationshipId}`);

          // Update description and weight if provided
          if (description || weight !== 1.0) {
            this.db.run(
              'UPDATE relationships SET description = COALESCE(?, description), weight = ? WHERE id = ?',
              [description, weight, relationshipId]
            );
          }

          return relationshipId;
        }
      }
      throw error;
    }
  }

  /**
   * Insert entity mention
   * @param {number} entityId - Entity ID
   * @param {number} chunkId - Chunk ID
   * @param {string} mentionText - The actual mention text
   * @param {number} confidence - Confidence score (0-1)
   * @returns {number} Mention ID
   */
  insertEntityMention(entityId, chunkId, mentionText = null, confidence = 1.0) {
    try {
      this.db.run(
        'INSERT INTO entity_mentions (entity_id, chunk_id, mention_text, confidence) VALUES (?, ?, ?, ?)',
        [entityId, chunkId, mentionText, confidence]
      );

      const result = this.db.exec('SELECT last_insert_rowid() as id');
      const mentionId = result[0].values[0][0];

      return mentionId;
    } catch (error) {
      // If mention already exists (UNIQUE constraint), ignore
      if (error.message.includes('UNIQUE constraint failed')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Insert relationship mention
   * @param {number} relationshipId - Relationship ID
   * @param {number} chunkId - Chunk ID
   * @param {string} context - Context where relationship was mentioned
   * @param {number} confidence - Confidence score (0-1)
   * @returns {number} Mention ID
   */
  insertRelationshipMention(relationshipId, chunkId, context = null, confidence = 1.0) {
    try {
      this.db.run(
        'INSERT INTO relationship_mentions (relationship_id, chunk_id, context, confidence) VALUES (?, ?, ?, ?)',
        [relationshipId, chunkId, context, confidence]
      );

      const result = this.db.exec('SELECT last_insert_rowid() as id');
      const mentionId = result[0].values[0][0];

      return mentionId;
    } catch (error) {
      // If mention already exists (UNIQUE constraint), ignore
      if (error.message.includes('UNIQUE constraint failed')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Update relationship weight (e.g., based on mention count)
   * @param {number} relationshipId - Relationship ID
   * @param {number} weight - New weight value
   */
  updateRelationshipWeight(relationshipId, weight) {
    this.db.run(
      'UPDATE relationships SET weight = ? WHERE id = ?',
      [weight, relationshipId]
    );
  }

  /**
   * Cleanup orphaned entities and relationships
   * This should be called after deleting chunks to maintain referential integrity
   */
  cleanupOrphanedGraphData() {
    console.log('[Database] Cleaning up orphaned graph data...');

    // Delete entities with no mentions
    this.db.exec(`
      DELETE FROM entities
      WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)
    `);

    // Delete relationships with no mentions
    this.db.exec(`
      DELETE FROM relationships
      WHERE id NOT IN (SELECT DISTINCT relationship_id FROM relationship_mentions)
    `);

    console.log('[Database] Orphaned graph data cleanup completed');
    this.save();
  }

  /**
   * Get entities mentioned in a specific chunk
   * @param {number} chunkId - Chunk ID
   * @returns {Array} Array of entities with mention info
   */
  getEntitiesByChunkId(chunkId) {
    const result = this.db.exec(
      `SELECT e.*, em.mention_text, em.confidence
       FROM entities e
       JOIN entity_mentions em ON e.id = em.entity_id
       WHERE em.chunk_id = ?`,
      [chunkId]
    );

    if (result.length === 0) {
      return [];
    }

    const columns = result[0].columns;
    return result[0].values.map(row => ({
      id: row[columns.indexOf('id')],
      name: row[columns.indexOf('name')],
      type: row[columns.indexOf('type')],
      description: row[columns.indexOf('description')],
      mention_text: row[columns.indexOf('mention_text')],
      confidence: row[columns.indexOf('confidence')]
    }));
  }

  /**
   * Get all relationships for a specific entity
   * @param {number} entityId - Entity ID
   * @returns {Array} Array of relationships with related entity info
   */
  getRelationshipsByEntityId(entityId) {
    const result = this.db.exec(
      `SELECT r.*,
              e1.name as source_name, e1.type as source_type,
              e2.name as target_name, e2.type as target_type
       FROM relationships r
       JOIN entities e1 ON r.source_entity_id = e1.id
       JOIN entities e2 ON r.target_entity_id = e2.id
       WHERE r.source_entity_id = ? OR r.target_entity_id = ?`,
      [entityId, entityId]
    );

    if (result.length === 0) {
      return [];
    }

    const columns = result[0].columns;
    return result[0].values.map(row => ({
      id: row[columns.indexOf('id')],
      source_entity_id: row[columns.indexOf('source_entity_id')],
      target_entity_id: row[columns.indexOf('target_entity_id')],
      relationship_type: row[columns.indexOf('relationship_type')],
      description: row[columns.indexOf('description')],
      weight: row[columns.indexOf('weight')],
      source_name: row[columns.indexOf('source_name')],
      source_type: row[columns.indexOf('source_type')],
      target_name: row[columns.indexOf('target_name')],
      target_type: row[columns.indexOf('target_type')]
    }));
  }

  /**
   * Get knowledge graph statistics
   * @returns {Object} Statistics about entities and relationships
   */
  getGraphStats() {
    const entityCount = this.db.exec('SELECT COUNT(*) as count FROM entities');
    const relationshipCount = this.db.exec('SELECT COUNT(*) as count FROM relationships');
    const mentionCount = this.db.exec('SELECT COUNT(*) as count FROM entity_mentions');

    return {
      entities: entityCount[0]?.values[0][0] || 0,
      relationships: relationshipCount[0]?.values[0][0] || 0,
      mentions: mentionCount[0]?.values[0][0] || 0
    };
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
