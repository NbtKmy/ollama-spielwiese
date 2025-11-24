/**
 * GraphRAG Entity and Relationship Types for Academic Papers
 *
 * This module defines the ontology for extracting entities and relationships
 * from academic papers, optimized for both STEM and humanities research.
 */

/**
 * Entity Types
 */
const ENTITY_TYPES = {
  // Authors and researchers (著者・研究者)
  PERSON: 'PERSON',

  // Research subjects: people as topics (philosophers, writers), themes, subjects
  // 研究対象：哲学者、作家などの人物、テーマ、主題
  TOPIC: 'TOPIC',

  // Research methods and analytical approaches
  // 研究手法・分析アプローチ
  RESEARCH_METHOD: 'RESEARCH_METHOD',

  // Cited papers (not the current document being processed)
  // 引用文献（処理中の文書は含まない）
  PAPER: 'PAPER',

  // Theories, concepts, terms
  // 理論、概念、用語
  CONCEPT: 'CONCEPT',

  // Universities, research institutions, publishers
  // 大学、研究機関、出版社
  ORGANIZATION: 'ORGANIZATION',

  // Datasets used in research
  // 研究で使用されるデータセット
  DATASET: 'DATASET'
};

/**
 * Relationship Types
 */
const RELATIONSHIP_TYPES = {
  // Authorship: PERSON -> PAPER
  // 著作関係
  AUTHORED: 'AUTHORED',

  // Affiliation: PERSON -> ORGANIZATION
  // 所属関係
  AFFILIATED_WITH: 'AFFILIATED_WITH',

  // Citation: PAPER -> PAPER
  // 引用関係
  CITES: 'CITES',

  // Topic relation: PAPER -> TOPIC
  // 論文が扱うトピック
  ABOUT: 'ABOUT',

  // Research subject: PAPER -> TOPIC (for more specific subject-object relationship)
  // 研究対象（より具体的な主客関係）
  STUDIES: 'STUDIES',

  // Method usage: PAPER -> RESEARCH_METHOD
  // 手法の使用
  USES_METHOD: 'USES_METHOD',

  // Dataset usage: PAPER -> DATASET
  // データセット使用
  USES_DATASET: 'USES_DATASET',

  // Concept foundation: CONCEPT -> CONCEPT, RESEARCH_METHOD -> CONCEPT
  // 概念の基礎
  BASED_ON: 'BASED_ON',

  // Extension: CONCEPT -> CONCEPT, RESEARCH_METHOD -> RESEARCH_METHOD
  // 拡張関係
  EXTENDS: 'EXTENDS',

  // Contradiction: CONCEPT -> CONCEPT
  // 矛盾・対立関係
  CONTRADICTS: 'CONTRADICTS',

  // Proposal: PERSON/PAPER -> CONCEPT/RESEARCH_METHOD
  // 提案関係
  PROPOSES: 'PROPOSES',

  // General semantic relationship (catch-all for domain-specific relationships)
  // 一般的な意味関係（ドメイン固有の関係のキャッチオール）
  RELATED_TO: 'RELATED_TO'
};

/**
 * Entity type descriptions for LLM prompts
 */
const ENTITY_TYPE_DESCRIPTIONS = {
  [ENTITY_TYPES.PERSON]: 'Authors, researchers, scholars (not research subjects)',
  [ENTITY_TYPES.TOPIC]: 'Research subjects when they are people (e.g., philosophers, writers), themes, main topics',
  [ENTITY_TYPES.RESEARCH_METHOD]: 'Research methods, analytical approaches, methodologies',
  [ENTITY_TYPES.PAPER]: 'Cited papers, referenced works (not the current document)',
  [ENTITY_TYPES.CONCEPT]: 'Theories, concepts, technical terms, theoretical frameworks',
  [ENTITY_TYPES.ORGANIZATION]: 'Universities, research institutions, publishers, academic organizations',
  [ENTITY_TYPES.DATASET]: 'Named datasets used in research (e.g., ImageNet, MNIST, corpora)'
};

/**
 * Relationship type descriptions for LLM prompts
 */
const RELATIONSHIP_TYPE_DESCRIPTIONS = {
  [RELATIONSHIP_TYPES.AUTHORED]: 'Person authored a paper',
  [RELATIONSHIP_TYPES.AFFILIATED_WITH]: 'Person is affiliated with an organization',
  [RELATIONSHIP_TYPES.CITES]: 'Paper cites another paper',
  [RELATIONSHIP_TYPES.ABOUT]: 'Paper is about a topic',
  [RELATIONSHIP_TYPES.STUDIES]: 'Paper studies a specific subject (more specific than ABOUT)',
  [RELATIONSHIP_TYPES.USES_METHOD]: 'Paper uses a research method',
  [RELATIONSHIP_TYPES.USES_DATASET]: 'Paper uses a dataset',
  [RELATIONSHIP_TYPES.BASED_ON]: 'Concept/method is based on another concept',
  [RELATIONSHIP_TYPES.EXTENDS]: 'Concept/method extends another concept/method',
  [RELATIONSHIP_TYPES.CONTRADICTS]: 'Concept contradicts another concept',
  [RELATIONSHIP_TYPES.PROPOSES]: 'Person/paper proposes a concept or method',
  [RELATIONSHIP_TYPES.RELATED_TO]: 'General semantic relationship between entities'
};

/**
 * Valid relationship patterns (source -> target)
 * Used for validation during extraction
 */
const VALID_RELATIONSHIP_PATTERNS = {
  [RELATIONSHIP_TYPES.AUTHORED]: {
    source: [ENTITY_TYPES.PERSON],
    target: [ENTITY_TYPES.PAPER]
  },
  [RELATIONSHIP_TYPES.AFFILIATED_WITH]: {
    source: [ENTITY_TYPES.PERSON],
    target: [ENTITY_TYPES.ORGANIZATION]
  },
  [RELATIONSHIP_TYPES.CITES]: {
    source: [ENTITY_TYPES.PAPER],
    target: [ENTITY_TYPES.PAPER]
  },
  [RELATIONSHIP_TYPES.ABOUT]: {
    source: [ENTITY_TYPES.PAPER],
    target: [ENTITY_TYPES.TOPIC]
  },
  [RELATIONSHIP_TYPES.STUDIES]: {
    source: [ENTITY_TYPES.PAPER],
    target: [ENTITY_TYPES.TOPIC]
  },
  [RELATIONSHIP_TYPES.USES_METHOD]: {
    source: [ENTITY_TYPES.PAPER],
    target: [ENTITY_TYPES.RESEARCH_METHOD]
  },
  [RELATIONSHIP_TYPES.USES_DATASET]: {
    source: [ENTITY_TYPES.PAPER],
    target: [ENTITY_TYPES.DATASET]
  },
  [RELATIONSHIP_TYPES.BASED_ON]: {
    source: [ENTITY_TYPES.CONCEPT, ENTITY_TYPES.RESEARCH_METHOD],
    target: [ENTITY_TYPES.CONCEPT]
  },
  [RELATIONSHIP_TYPES.EXTENDS]: {
    source: [ENTITY_TYPES.CONCEPT, ENTITY_TYPES.RESEARCH_METHOD],
    target: [ENTITY_TYPES.CONCEPT, ENTITY_TYPES.RESEARCH_METHOD]
  },
  [RELATIONSHIP_TYPES.CONTRADICTS]: {
    source: [ENTITY_TYPES.CONCEPT],
    target: [ENTITY_TYPES.CONCEPT]
  },
  [RELATIONSHIP_TYPES.PROPOSES]: {
    source: [ENTITY_TYPES.PERSON, ENTITY_TYPES.PAPER],
    target: [ENTITY_TYPES.CONCEPT, ENTITY_TYPES.RESEARCH_METHOD]
  },
  [RELATIONSHIP_TYPES.RELATED_TO]: {
    source: Object.values(ENTITY_TYPES),
    target: Object.values(ENTITY_TYPES)
  }
};

/**
 * Validate if a relationship pattern is valid
 * @param {string} relationshipType - Relationship type
 * @param {string} sourceEntityType - Source entity type
 * @param {string} targetEntityType - Target entity type
 * @returns {boolean} True if valid
 */
function isValidRelationship(relationshipType, sourceEntityType, targetEntityType) {
  const pattern = VALID_RELATIONSHIP_PATTERNS[relationshipType];
  if (!pattern) {
    console.warn(`[GraphRAG] Unknown relationship type: ${relationshipType}`);
    return false;
  }

  const validSource = pattern.source.includes(sourceEntityType);
  const validTarget = pattern.target.includes(targetEntityType);

  if (!validSource || !validTarget) {
    console.warn(
      `[GraphRAG] Invalid relationship pattern: ${sourceEntityType} -[${relationshipType}]-> ${targetEntityType}`
    );
    return false;
  }

  return true;
}

/**
 * Generate a prompt-friendly description of all entity types
 * @returns {string} Formatted entity types for LLM prompt
 */
function getEntityTypesPrompt() {
  return Object.entries(ENTITY_TYPE_DESCRIPTIONS)
    .map(([type, description]) => `- ${type}: ${description}`)
    .join('\n');
}

/**
 * Generate a prompt-friendly description of all relationship types
 * @returns {string} Formatted relationship types for LLM prompt
 */
function getRelationshipTypesPrompt() {
  return Object.entries(RELATIONSHIP_TYPE_DESCRIPTIONS)
    .map(([type, description]) => `- ${type}: ${description}`)
    .join('\n');
}

module.exports = {
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  ENTITY_TYPE_DESCRIPTIONS,
  RELATIONSHIP_TYPE_DESCRIPTIONS,
  VALID_RELATIONSHIP_PATTERNS,
  isValidRelationship,
  getEntityTypesPrompt,
  getRelationshipTypesPrompt
};
