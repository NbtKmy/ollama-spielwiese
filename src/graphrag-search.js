/**
 * GraphRAG Search Functions
 *
 * Implements entity-based search combining keyword and embedding approaches
 */

/**
 * Search entities by keyword (name matching)
 * @param {Database} db - Database instance
 * @param {string} query - Search query
 * @param {number} limit - Maximum results
 * @returns {Array} Matching entities with scores
 */
function searchEntitiesByKeyword(db, query, limit = 10) {
  const keywords = query.toLowerCase().trim().split(/\s+/).filter(k => k.length > 0);

  if (keywords.length === 0) {
    return [];
  }

  // Build LIKE conditions for entity name matching
  const likeConditions = keywords.map(() => 'LOWER(e.name) LIKE ?').join(' OR ');
  const likeParams = keywords.map(k => `%${k}%`);

  const result = db.db.exec(
    `SELECT e.*, COUNT(em.id) as mention_count
     FROM entities e
     LEFT JOIN entity_mentions em ON e.id = em.entity_id
     WHERE ${likeConditions}
     GROUP BY e.id
     ORDER BY mention_count DESC
     LIMIT ?`,
    [...likeParams, limit * 2] // Get more for scoring
  );

  if (result.length === 0) {
    return [];
  }

  const columns = result[0].columns;
  const entities = result[0].values.map(row => ({
    id: row[columns.indexOf('id')],
    name: row[columns.indexOf('name')],
    type: row[columns.indexOf('type')],
    description: row[columns.indexOf('description')],
    mention_count: row[columns.indexOf('mention_count')]
  }));

  // Calculate keyword match score
  const scoredEntities = entities.map(entity => {
    const nameLower = entity.name.toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
      if (nameLower.includes(keyword)) {
        score += 1;
        // Bonus for exact match
        if (nameLower === keyword) {
          score += 2;
        }
      }
    }

    // Boost by mention count (popularity)
    score += Math.log(entity.mention_count + 1) * 0.5;

    return { ...entity, score };
  });

  // Sort by score and limit
  scoredEntities.sort((a, b) => b.score - a.score);
  return scoredEntities.slice(0, limit);
}

/**
 * Search entities by embedding (semantic similarity)
 * @param {FaissStore} entityVectorStore - Entity vector store
 * @param {Database} db - Database instance
 * @param {string} query - Search query
 * @param {number} k - Number of results
 * @returns {Promise<Array>} Similar entities
 */
async function searchEntitiesByEmbedding(entityVectorStore, db, query, k = 10) {
  if (!entityVectorStore) {
    console.warn('[GraphRAG] Entity vector store not loaded');
    return [];
  }

  try {
    // Search entity vector store
    const results = await entityVectorStore.similaritySearch(query, k);

    // Enrich with database information
    const entities = results.map((doc, index) => {
      const entityId = doc.metadata?.entity_id;
      if (!entityId) return null;

      // Get full entity info from database
      const dbResult = db.db.exec(
        `SELECT e.*, COUNT(em.id) as mention_count
         FROM entities e
         LEFT JOIN entity_mentions em ON e.id = em.entity_id
         WHERE e.id = ?
         GROUP BY e.id`,
        [entityId]
      );

      if (dbResult.length === 0) return null;

      const columns = dbResult[0].columns;
      const row = dbResult[0].values[0];

      return {
        id: row[columns.indexOf('id')],
        name: row[columns.indexOf('name')],
        type: row[columns.indexOf('type')],
        description: row[columns.indexOf('description')],
        mention_count: row[columns.indexOf('mention_count')],
        score: (k - index) / k // Similarity-based score
      };
    }).filter(e => e !== null);

    return entities;
  } catch (error) {
    console.error('[GraphRAG] Entity embedding search failed:', error);
    return [];
  }
}

/**
 * Combine keyword and embedding search results
 * @param {Array} keywordResults - Results from keyword search
 * @param {Array} embeddingResults - Results from embedding search
 * @param {number} topK - Number of top entities to return
 * @returns {Array} Merged and deduplicated results
 */
function mergeEntitySearchResults(keywordResults, embeddingResults, topK = 3) {
  const entityMap = new Map();

  // Add keyword results
  for (const entity of keywordResults) {
    entityMap.set(entity.id, {
      ...entity,
      keywordScore: entity.score,
      embeddingScore: 0
    });
  }

  // Add/merge embedding results
  for (const entity of embeddingResults) {
    if (entityMap.has(entity.id)) {
      const existing = entityMap.get(entity.id);
      existing.embeddingScore = entity.score;
      existing.score = existing.keywordScore + existing.embeddingScore;
    } else {
      entityMap.set(entity.id, {
        ...entity,
        keywordScore: 0,
        embeddingScore: entity.score
      });
    }
  }

  // Sort by combined score
  const merged = Array.from(entityMap.values());
  merged.sort((a, b) => b.score - a.score);

  return merged.slice(0, topK);
}

/**
 * Get weight multiplier for relationship type
 * @param {string} relationshipType - Relationship type
 * @returns {number} Weight multiplier
 */
function getRelationshipTypeWeight(relationshipType) {
  const weights = {
    'CITES': 2.0,           // Citations are very important
    'AUTHORED': 1.8,        // Authorship is important
    'PROPOSES': 1.5,        // Proposals are significant
    'EXTENDS': 1.3,         // Extensions show development
    'BASED_ON': 1.3,        // Foundations are important
    'USES_METHOD': 1.2,     // Method usage is relevant
    'USES_DATASET': 1.2,    // Dataset usage is relevant
    'STUDIES': 1.1,         // Study relationships
    'ABOUT': 1.1,           // Topic relationships
    'CONTRADICTS': 1.0,     // Contradictions (neutral)
    'RELATED_TO': 0.8,      // Generic relationships (lower weight)
    'AFFILIATED_WITH': 0.7  // Affiliations (organizational context)
  };

  return weights[relationshipType] || 1.0;
}

/**
 * Find related entities through relationships
 * @param {Database} db - Database instance
 * @param {Array<number>} entityIds - Source entity IDs
 * @param {number} maxRelated - Maximum related entities to return
 * @returns {Array} Related entities with relationship info
 */
function findRelatedEntities(db, entityIds, maxRelated = 5) {
  if (entityIds.length === 0) {
    return [];
  }

  const placeholders = entityIds.map(() => '?').join(',');

  // Find entities connected through relationships (both directions)
  const result = db.db.exec(
    `SELECT DISTINCT
       e.id, e.name, e.type, e.description,
       r.relationship_type, r.weight, r.description as rel_description,
       CASE
         WHEN r.source_entity_id IN (${placeholders}) THEN r.target_entity_id
         ELSE r.source_entity_id
       END as connected_entity_id
     FROM relationships r
     JOIN entities e ON (
       (r.source_entity_id IN (${placeholders}) AND e.id = r.target_entity_id) OR
       (r.target_entity_id IN (${placeholders}) AND e.id = r.source_entity_id)
     )
     WHERE e.id NOT IN (${placeholders})
     ORDER BY r.weight DESC
     LIMIT ?`,
    [...entityIds, ...entityIds, ...entityIds, ...entityIds, maxRelated * 2]
  );

  if (result.length === 0) {
    return [];
  }

  const columns = result[0].columns;
  const entities = result[0].values.map(row => ({
    id: row[columns.indexOf('id')],
    name: row[columns.indexOf('name')],
    type: row[columns.indexOf('type')],
    description: row[columns.indexOf('description')],
    relationship_type: row[columns.indexOf('relationship_type')],
    weight: row[columns.indexOf('weight')],
    rel_description: row[columns.indexOf('rel_description')]
  }));

  // Apply relationship type weights and re-sort
  const weightedEntities = entities.map(entity => ({
    ...entity,
    weighted_score: entity.weight * getRelationshipTypeWeight(entity.relationship_type)
  }));

  weightedEntities.sort((a, b) => b.weighted_score - a.weighted_score);

  console.log(`[GraphRAG] Top related entities:`,
    weightedEntities.slice(0, maxRelated).map(e =>
      `${e.name} (${e.relationship_type}, score: ${e.weighted_score.toFixed(2)})`
    )
  );

  return weightedEntities.slice(0, maxRelated);
}

/**
 * Get chunks associated with entities
 * @param {Database} db - Database instance
 * @param {Array<number>} entityIds - Entity IDs
 * @returns {Array} Chunks with entity context
 */
function getChunksFromEntities(db, entityIds) {
  if (entityIds.length === 0) {
    return [];
  }

  const placeholders = entityIds.map(() => '?').join(',');

  const result = db.db.exec(
    `SELECT DISTINCT
       c.id, c.content, c.page, c.chunk_index,
       d.source, d.embedding_model,
       GROUP_CONCAT(DISTINCT e.name) as entity_names,
       GROUP_CONCAT(DISTINCT e.type) as entity_types,
       COUNT(DISTINCT em.entity_id) as entity_count
     FROM chunks c
     JOIN documents d ON c.document_id = d.id
     JOIN entity_mentions em ON c.id = em.chunk_id
     JOIN entities e ON em.entity_id = e.id
     WHERE em.entity_id IN (${placeholders})
     GROUP BY c.id
     ORDER BY entity_count DESC, c.chunk_index`,
    entityIds
  );

  if (result.length === 0) {
    return [];
  }

  const columns = result[0].columns;
  return result[0].values.map(row => ({
    id: row[columns.indexOf('id')],
    content: row[columns.indexOf('content')],
    page: row[columns.indexOf('page')],
    chunk_index: row[columns.indexOf('chunk_index')],
    source: row[columns.indexOf('source')],
    embedding_model: row[columns.indexOf('embedding_model')],
    entity_names: row[columns.indexOf('entity_names')]?.split(',') || [],
    entity_types: row[columns.indexOf('entity_types')]?.split(',') || [],
    entity_count: row[columns.indexOf('entity_count')]
  }));
}

/**
 * Main GraphRAG search function
 * @param {Object} options - Search options
 * @param {Database} options.db - Database instance
 * @param {FaissStore} options.entityVectorStore - Entity vector store
 * @param {string} options.query - Search query
 * @param {number} options.topEntities - Number of initial entities to find
 * @param {number} options.maxRelated - Maximum related entities
 * @param {number} options.maxChunks - Maximum chunks to return
 * @returns {Promise<Object>} Search results with entities and chunks
 */
async function graphRagSearch({
  db,
  entityVectorStore,
  query,
  topEntities = 3,
  maxRelated = 5,
  maxChunks = 5
}) {
  console.log(`[GraphRAG Search] Query: "${query}"`);

  // Step 1: Find initial entities (keyword + embedding)
  const keywordEntities = searchEntitiesByKeyword(db, query, 10);
  const embeddingEntities = await searchEntitiesByEmbedding(entityVectorStore, db, query, 10);

  console.log(`[GraphRAG Search] Found ${keywordEntities.length} keyword matches, ${embeddingEntities.length} embedding matches`);

  const topInitialEntities = mergeEntitySearchResults(keywordEntities, embeddingEntities, topEntities);

  if (topInitialEntities.length === 0) {
    console.log('[GraphRAG Search] No entities found');
    return { entities: [], relatedEntities: [], chunks: [] };
  }

  console.log(`[GraphRAG Search] Top ${topInitialEntities.length} entities:`, topInitialEntities.map(e => e.name));

  // Step 2: Find related entities
  const initialEntityIds = topInitialEntities.map(e => e.id);
  const relatedEntities = findRelatedEntities(db, initialEntityIds, maxRelated);

  console.log(`[GraphRAG Search] Found ${relatedEntities.length} related entities`);

  // Step 3: Get chunks from all entities
  const allEntityIds = [
    ...initialEntityIds,
    ...relatedEntities.map(e => e.id)
  ];

  const chunks = getChunksFromEntities(db, allEntityIds);

  console.log(`[GraphRAG Search] Found ${chunks.length} chunks`);

  return {
    entities: topInitialEntities,
    relatedEntities: relatedEntities,
    chunks: chunks.slice(0, maxChunks)
  };
}

module.exports = {
  searchEntitiesByKeyword,
  searchEntitiesByEmbedding,
  mergeEntitySearchResults,
  findRelatedEntities,
  getChunksFromEntities,
  graphRagSearch
};
