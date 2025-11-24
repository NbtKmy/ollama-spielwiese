/**
 * GraphRAG Entity and Relationship Extractor
 *
 * Extracts entities and relationships from academic paper chunks using LLM.
 */

const {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  getEntityTypesPrompt,
  getRelationshipTypesPrompt,
  isValidRelationship
} = require('./graphrag-types.js');

/**
 * Generate extraction prompt for LLM
 * @param {string} chunkContent - The text content to extract from
 * @returns {string} Formatted prompt
 */
function generateExtractionPrompt(chunkContent) {
  return `You are an expert at extracting entities and relationships from academic papers. Your task is to identify key entities and their relationships from the provided text chunk.

## Entity Types
${getEntityTypesPrompt()}

## Relationship Types
${getRelationshipTypesPrompt()}

## Instructions
1. Extract ALL significant entities that match the types above
2. Identify clear relationships between entities
3. Provide concise descriptions for entities and relationships
4. Use exact names as they appear in the text (preserve capitalization)
5. For PERSON entities: extract only authors/researchers, NOT subjects of study
6. For TOPIC entities: extract research subjects, especially when they are historical figures
7. For PAPER entities: extract only cited/referenced papers, NOT the current document

## Output Format
CRITICAL: Your entire response MUST be ONLY a valid JSON object. Do NOT include ANY text, explanation, or commentary before or after the JSON.

REQUIRED:
- Return ONLY the JSON object, starting with { and ending with }
- Use DOUBLE QUOTES (") for all strings, NOT single quotes (')
- No trailing commas
- No comments
- No markdown code blocks (no \`\`\`)
- No explanatory text whatsoever

Your response should start with { and end with }

{
  "entities": [
    {
      "name": "Entity Name",
      "type": "ENTITY_TYPE",
      "description": "Brief description of the entity"
    }
  ],
  "relationships": [
    {
      "source": "Source Entity Name",
      "target": "Target Entity Name",
      "type": "RELATIONSHIP_TYPE",
      "description": "Brief description of the relationship"
    }
  ]
}

## Example

Text: "Kant's categorical imperative, as analyzed by Christine Korsgaard at Harvard, provides a foundation for modern deontological ethics."

Output:
{
  "entities": [
    {
      "name": "Kant",
      "type": "TOPIC",
      "description": "Philosopher whose categorical imperative is being studied"
    },
    {
      "name": "Christine Korsgaard",
      "type": "PERSON",
      "description": "Researcher analyzing Kant's work"
    },
    {
      "name": "Harvard",
      "type": "ORGANIZATION",
      "description": "Academic institution"
    },
    {
      "name": "categorical imperative",
      "type": "CONCEPT",
      "description": "Kant's ethical principle"
    },
    {
      "name": "deontological ethics",
      "type": "CONCEPT",
      "description": "Modern ethical framework"
    }
  ],
  "relationships": [
    {
      "source": "Christine Korsgaard",
      "target": "Harvard",
      "type": "AFFILIATED_WITH",
      "description": "Korsgaard is affiliated with Harvard"
    },
    {
      "source": "Christine Korsgaard",
      "target": "Kant",
      "type": "STUDIES",
      "description": "Korsgaard analyzes Kant's philosophy"
    },
    {
      "source": "categorical imperative",
      "target": "deontological ethics",
      "type": "RELATED_TO",
      "description": "The categorical imperative provides foundation for deontological ethics"
    }
  ]
}

## Text to Extract From

${chunkContent}

## Your Output (JSON only)`;
}

/**
 * Parse and validate extraction result from LLM
 * @param {string} llmOutput - Raw output from LLM
 * @returns {Object|null} Parsed result or null if invalid
 */
function parseExtractionResult(llmOutput) {
  try {
    // Log raw output for debugging
    console.log('[GraphRAG] Raw LLM output length:', llmOutput.length);
    console.log('[GraphRAG] Raw LLM output (first 1000 chars):');
    console.log(llmOutput.substring(0, 1000));
    console.log('[GraphRAG] ---');

    // Remove markdown code blocks if present
    let cleaned = llmOutput.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/```\n?/g, '');
    }

    // Try to extract JSON object from text
    // Look for the first { and last } to extract just the JSON part
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
      const extractedJson = cleaned.substring(firstBrace, lastBrace + 1);
      if (extractedJson.length < cleaned.length) {
        console.log('[GraphRAG] Extracted JSON from mixed content');
        cleaned = extractedJson;
      }
    }

    // Try to fix common JSON issues
    // Replace single quotes with double quotes (if they're property quotes)
    cleaned = cleaned.replace(/'\s*:\s*/g, '": ');
    cleaned = cleaned.replace(/:\s*'/g, ': "');
    cleaned = cleaned.replace(/,\s*'/g, ', "');
    cleaned = cleaned.replace(/\[\s*'/g, '["');
    cleaned = cleaned.replace(/'\s*\]/g, '"]');
    cleaned = cleaned.replace(/\{\s*'/g, '{"');

    console.log('[GraphRAG] Cleaned JSON (first 500 chars):', cleaned.substring(0, 500));

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[GraphRAG] JSON parse error:', parseError.message);

      // Extract error position
      const match = parseError.message.match(/position (\d+)/);
      if (match) {
        const pos = parseInt(match[1]);
        const start = Math.max(0, pos - 100);
        const end = Math.min(cleaned.length, pos + 100);
        console.error('[GraphRAG] Error context:', cleaned.substring(start, end));
        console.error('[GraphRAG] Error at position:', pos, '(^)');
      }

      // Try one more time with more aggressive cleaning
      console.log('[GraphRAG] Attempting more aggressive JSON fixes...');

      // Remove trailing commas
      cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

      // Fix unquoted property names
      cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

      // Try parsing again
      try {
        result = JSON.parse(cleaned);
        console.log('[GraphRAG] Successfully parsed after aggressive fixes');
      } catch (secondError) {
        console.error('[GraphRAG] Still failed after aggressive fixes:', secondError.message);
        console.error('[GraphRAG] Failed JSON content (first 1000 chars):');
        console.error(cleaned.substring(0, 1000));
        console.error('[GraphRAG] Please check if the LLM is returning valid JSON format');
        return null;
      }
    }

    // Validate structure
    if (!result.entities || !Array.isArray(result.entities)) {
      console.warn('[GraphRAG] Invalid extraction result: missing entities array');
      return null;
    }

    if (!result.relationships || !Array.isArray(result.relationships)) {
      console.warn('[GraphRAG] Invalid extraction result: missing relationships array');
      return null;
    }

    // Validate entities
    const validEntities = result.entities.filter(entity => {
      if (!entity.name || !entity.type) {
        console.warn('[GraphRAG] Skipping invalid entity:', entity);
        return false;
      }

      if (!Object.values(ENTITY_TYPES).includes(entity.type)) {
        console.warn(`[GraphRAG] Unknown entity type: ${entity.type}`);
        return false;
      }

      return true;
    });

    // Create entity name -> type mapping for relationship validation
    const entityMap = new Map();
    validEntities.forEach(entity => {
      entityMap.set(entity.name, entity.type);
    });

    // Validate relationships
    const validRelationships = result.relationships.filter(rel => {
      if (!rel.source || !rel.target || !rel.type) {
        console.warn('[GraphRAG] Skipping invalid relationship:', rel);
        return false;
      }

      if (!Object.values(RELATIONSHIP_TYPES).includes(rel.type)) {
        console.warn(`[GraphRAG] Unknown relationship type: ${rel.type}`);
        return false;
      }

      // Check if source and target entities exist
      const sourceType = entityMap.get(rel.source);
      const targetType = entityMap.get(rel.target);

      if (!sourceType || !targetType) {
        console.warn(
          `[GraphRAG] Relationship references non-existent entity: ${rel.source} -> ${rel.target}`
        );
        return false;
      }

      // Validate relationship pattern
      if (!isValidRelationship(rel.type, sourceType, targetType)) {
        return false;
      }

      return true;
    });

    return {
      entities: validEntities,
      relationships: validRelationships
    };
  } catch (error) {
    console.error('[GraphRAG] Failed to parse extraction result:', error);
    console.error('[GraphRAG] Raw output:', llmOutput);
    return null;
  }
}

/**
 * Extract entities and relationships from a text chunk using LLM
 * @param {string} chunkContent - Text content to extract from
 * @param {Function} llmFunction - Function that takes a prompt and returns LLM response
 * @returns {Promise<Object|null>} Extracted entities and relationships
 */
async function extractFromChunk(chunkContent, llmFunction) {
  try {
    const prompt = generateExtractionPrompt(chunkContent);
    const llmOutput = await llmFunction(prompt);

    if (!llmOutput) {
      console.warn('[GraphRAG] LLM returned empty response');
      return null;
    }

    const result = parseExtractionResult(llmOutput);

    if (result) {
      console.log(
        `[GraphRAG] Extracted ${result.entities.length} entities and ${result.relationships.length} relationships`
      );
    }

    return result;
  } catch (error) {
    console.error('[GraphRAG] Extraction failed:', error);
    return null;
  }
}

/**
 * Store extracted entities and relationships in database
 * @param {Object} db - Database instance
 * @param {number} chunkId - Chunk ID
 * @param {Object} extraction - Extraction result with entities and relationships
 * @returns {Object} Statistics about stored data
 */
function storeExtraction(db, chunkId, extraction) {
  if (!extraction || !extraction.entities || !extraction.relationships) {
    return { entities: 0, relationships: 0, mentions: 0 };
  }

  const entityMap = new Map(); // name -> entity_id
  let entityCount = 0;
  let relationshipCount = 0;
  let mentionCount = 0;

  try {
    // Insert entities and create mentions
    for (const entity of extraction.entities) {
      const entityId = db.insertEntity(entity.name, entity.type, entity.description);
      entityMap.set(entity.name, entityId);
      entityCount++;

      // Create entity mention
      const mentionId = db.insertEntityMention(entityId, chunkId, entity.name, 1.0);
      if (mentionId) {
        mentionCount++;
      }
    }

    // Insert relationships and create mentions
    for (const rel of extraction.relationships) {
      const sourceId = entityMap.get(rel.source);
      const targetId = entityMap.get(rel.target);

      if (!sourceId || !targetId) {
        console.warn(
          `[GraphRAG] Skipping relationship with missing entities: ${rel.source} -> ${rel.target}`
        );
        continue;
      }

      const relationshipId = db.insertRelationship(
        sourceId,
        targetId,
        rel.type,
        rel.description,
        1.0
      );
      relationshipCount++;

      // Create relationship mention
      db.insertRelationshipMention(relationshipId, chunkId, rel.description, 1.0);
    }

    db.save();

    console.log(
      `[GraphRAG] Stored ${entityCount} entities, ${relationshipCount} relationships, ${mentionCount} mentions for chunk ${chunkId}`
    );

    return { entities: entityCount, relationships: relationshipCount, mentions: mentionCount };
  } catch (error) {
    console.error('[GraphRAG] Failed to store extraction:', error);
    return { entities: 0, relationships: 0, mentions: 0 };
  }
}

module.exports = {
  generateExtractionPrompt,
  parseExtractionResult,
  extractFromChunk,
  storeExtraction
};
