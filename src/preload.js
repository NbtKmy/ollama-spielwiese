const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist');
pdfjsLib.GlobalWorkerOptions.workerSrc = require('pdfjs-dist/build/pdf.worker.entry');
const matter = require('gray-matter');
const { FaissStore } = require('@langchain/community/vectorstores/faiss');
const { Document } = require('langchain/document');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { OllamaEmbeddings } = require('@langchain/ollama');
const Database = require('./database');
const { extractFromChunk, storeExtraction } = require('./graphrag-extractor');
const { graphRagSearch } = require('./graphrag-search');


let embedder = new OllamaEmbeddings({
  model: 'bge-m3',
});

// メインプロセスから渡された環境変数を使用
const VECTOR_DIR = process.env.VECTOR_DB_PATH || path.join(__dirname, '../vector-db');

// Vector stores
let vectorStore = null; // Chunk embeddings
let entityVectorStore = null; // Entity embeddings for GraphRAG

// Helper function to normalize model names (remove :latest tag)
function normalizeModelName(modelName) {
  if (!modelName) return '';
  return modelName.replace(/:latest$/, '');
}

async function setEmbedderModel(name, force = false) {
  // 現在のモデル名を正規化
  const currentModelNormalized = normalizeModelName(embedder.model);
  const newModelNormalized = normalizeModelName(name);

  // モデル名が同じ場合は何もしない（データベースをクリアしない）
  if (currentModelNormalized === newModelNormalized && !force) {
    console.log(`[INFO] Embedding model unchanged: ${embedder.model}`);
    return { success: true };
  }

  console.log(`[INFO] Changing embedding model from ${embedder.model} to ${name}`);

  // forceフラグがfalseの場合のみ警告チェック
  if (!force) {
    const existingModels = await getExistingModels();

    if (existingModels.length > 0 && !existingModels.includes(name)) {
      return {
        success: false,
        existingModels,
        newModel: name
      };
    }
  }

  embedder = new OllamaEmbeddings({ model: name });

  // embedモデルが変更されたら、vectorStoreをリセット
  // 既存のベクトルストアは異なる次元数の可能性があるため、物理的なファイルも削除
  vectorStore = null;

  // 物理的なベクトルストアファイルも削除
  const storePath = path.join(VECTOR_DIR, 'faiss_store');
  try {
    if (fs.existsSync(storePath)) {
      fs.rmSync(storePath, { recursive: true, force: true });
      console.log('[INFO] Deleted existing FAISS store due to embedding model change');
    }
  } catch (error) {
    console.error('[ERROR] Failed to delete FAISS store:', error);
  }

  // SQLiteもクリア
  try {
    if (db && db.db) {
      db.db.run('DELETE FROM chunks');
      db.db.run('DELETE FROM documents');
      db.save();
      console.log('[INFO] Cleared SQLite database due to embedding model change');
    }
  } catch (error) {
    console.error('[ERROR] Failed to clear SQLite database:', error);
  }

  return { success: true };
}

async function getExistingModels() {
  if (!vectorStore) {
    return [];
  }

  try {
    const allDocs = await vectorStore.similaritySearch('', 9999);
    const models = new Set();

    for (const doc of allDocs) {
      if (doc.metadata?.embeddingModel) {
        models.add(doc.metadata.embeddingModel);
      }
    }

    return Array.from(models);
  } catch (error) {
    // 次元数ミスマッチエラーの場合は、ストアをクリア
    if (error.message && error.message.includes('dimensions')) {
      console.error('[ERROR] Vector store dimension mismatch in getExistingModels:', error.message);
      const storePath = path.join(VECTOR_DIR, 'faiss_store');
      try {
        fs.rmSync(storePath, { recursive: true, force: true });
        vectorStore = null;
      } catch (deleteError) {
        console.error('[ERROR] Failed to delete incompatible vector store:', deleteError);
      }
    }
    return [];
  }
}

async function checkEmbedModelExists() {
  try {
    console.log('[DEBUG] checkEmbedModelExists: Getting server port...');
    const port = await ipcRenderer.invoke('get-server-port');
    console.log('[DEBUG] checkEmbedModelExists: Server port:', port);

    if (!port) {
      return { exists: false, error: 'Server port not available' };
    }

    console.log('[DEBUG] checkEmbedModelExists: Fetching models from localhost:' + port);
    const response = await fetch(`http://localhost:${port}/models`);
    console.log('[DEBUG] checkEmbedModelExists: Response status:', response.status);

    if (!response.ok) {
      return { exists: false, error: 'Failed to fetch models from Ollama' };
    }

    const data = await response.json();
    console.log('[DEBUG] checkEmbedModelExists: Available models:', data.models);

    const currentModel = embedder.model;
    console.log('[DEBUG] checkEmbedModelExists: Current embedder model:', currentModel);

    const modelExists = data.models.some(model => model === currentModel || model.startsWith(currentModel + ':'));
    console.log('[DEBUG] checkEmbedModelExists: Model exists:', modelExists);

    return {
      exists: modelExists,
      currentModel: currentModel,
      availableModels: data.models
    };
  } catch (error) {
    console.error('[ERROR] checkEmbedModelExists: Exception:', error);
    return { exists: false, error: error.message };
  }
}


let db = null;

const LIST_PATH = path.join(VECTOR_DIR, 'sources.json');

// vector-dbディレクトリが存在しない場合は作成
if (!fs.existsSync(VECTOR_DIR)) {
  fs.mkdirSync(VECTOR_DIR, { recursive: true });
}

// Initialize database
const DB_PATH = path.join(VECTOR_DIR, 'documents.db');
db = new Database(DB_PATH);

/**
 * Generate embeddings for entities that don't have embeddings yet
 * @param {Database} db - Database instance
 * @param {string} embeddingModel - Embedding model name
 */
async function generateEntityEmbeddings(db, embeddingModel) {
  const entityStorePath = path.join(VECTOR_DIR, 'entity_faiss_store');

  try {
    console.log('[GraphRAG] Generating entity embeddings...');

    // Get all entities without embeddings for this model
    const result = db.db.exec(`
      SELECT e.id, e.name, e.type, e.description
      FROM entities e
      LEFT JOIN entity_embeddings ee
        ON e.id = ee.entity_id AND ee.embedding_model = ?
      WHERE ee.id IS NULL
    `, [embeddingModel]);

    if (result.length === 0 || result[0].values.length === 0) {
      console.log('[GraphRAG] No new entities to embed');
      // Still load existing entity vector store if available
      if (fs.existsSync(entityStorePath)) {
        entityVectorStore = await FaissStore.load(entityStorePath, embedder);
        console.log('[GraphRAG] Loaded existing entity vector store');
      }
      return;
    }

    const columns = result[0].columns;
    const entities = result[0].values.map(row => ({
      id: row[columns.indexOf('id')],
      name: row[columns.indexOf('name')],
      type: row[columns.indexOf('type')],
      description: row[columns.indexOf('description')]
    }));

    console.log(`[GraphRAG] Embedding ${entities.length} entities...`);

    // Prepare documents for FAISS
    const entityDocs = entities.map(entity => {
      // Combine name and description for richer embeddings
      const text = entity.description
        ? `${entity.name}: ${entity.description}`
        : entity.name;

      return new Document({
        pageContent: text,
        metadata: {
          entity_id: entity.id,
          entity_name: entity.name,
          entity_type: entity.type,
          embedding_model: embeddingModel
        }
      });
    });

    // Load or create entity vector store
    // IMPORTANT: Update the GLOBAL entityVectorStore variable
    if (fs.existsSync(entityStorePath)) {
      entityVectorStore = await FaissStore.load(entityStorePath, embedder);
      await entityVectorStore.addDocuments(entityDocs);
    } else {
      entityVectorStore = await FaissStore.fromDocuments(entityDocs, embedder);
    }

    // Save to disk
    await entityVectorStore.save(entityStorePath);

    // Get embedding dimension from the embedder
    const sampleEmbedding = await embedder.embedQuery('test');
    const dimension = sampleEmbedding.length;

    // Save embedding records to database
    for (const entity of entities) {
      db.db.run(
        'INSERT INTO entity_embeddings (entity_id, embedding_model, dimension) VALUES (?, ?, ?)',
        [entity.id, embeddingModel, dimension]
      );
    }

    db.save();

    console.log(`[GraphRAG] Embedded ${entities.length} entities (dimension: ${dimension})`);
  } catch (error) {
    console.error('[GraphRAG] Failed to generate entity embeddings:', error);
    // Non-fatal error, continue execution
  }
}

/**
 * Call LLM for GraphRAG entity extraction
 * @param {string} prompt - Extraction prompt
 * @param {string} modelName - LLM model name
 * @returns {Promise<string>} - LLM response
 */
async function callLLMForExtraction(prompt, modelName) {
  try {
    console.log(`[GraphRAG] Calling LLM (${modelName}) for entity extraction...`);
    console.log(`[GraphRAG] Prompt length: ${prompt.length} chars`);

    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1, // Low temperature for structured extraction
          num_predict: 3000, // Allow longer responses for JSON
          num_ctx: 4096      // Increase context window
        }
      })
    });

    if (!response.ok) {
      console.error('[GraphRAG] LLM HTTP error:', response.status, response.statusText);
      return null;
    }

    const data = await response.json();

    // Some models (like gpt-oss) use "thinking" field instead of "response"
    let llmOutput = data.response?.trim();

    if (!llmOutput && data.thinking) {
      console.log('[GraphRAG] Response empty, using thinking field instead');
      llmOutput = data.thinking.trim();
    }

    // Log the raw response for debugging
    console.log('[GraphRAG] LLM raw response:', {
      hasResponse: !!data.response,
      hasThinking: !!data.thinking,
      outputLength: llmOutput?.length || 0,
      outputPreview: llmOutput?.substring(0, 200) + '...'
    });

    if (!llmOutput || llmOutput.length === 0) {
      console.warn('[GraphRAG] LLM returned empty response and thinking');
      console.warn('[GraphRAG] Full response data:', JSON.stringify(data, null, 2));
      return null;
    }

    return llmOutput;
  } catch (error) {
    console.error('[GraphRAG] LLM call error:', error);
    return null;
  }
}

/**
 * Extract GraphRAG entities and relationships for a document
 * This function can be called separately from PDF upload
 * @param {string} source - Document source path
 * @param {string} chatModel - Chat model for extraction
 * @param {Function} progressCallback - Callback for progress updates
 * @returns {Promise<Object>} - Extraction statistics
 */
async function extractGraphRAGForDocument(source, chatModel, progressCallback = null) {
  try {
    // データベースの初期化を確認
    if (!db.db) {
      await db.init();
    }

    // Get document ID
    const docIds = db.getDocumentIdsBySource(source);
    if (docIds.length === 0) {
      throw new Error(`Document not found: ${source}`);
    }

    const docId = docIds[0];

    // Get all chunks for this document
    const chunks = db.getChunksByDocumentId(docId);
    if (chunks.length === 0) {
      throw new Error(`No chunks found for document: ${source}`);
    }

    console.log(`[GraphRAG] Starting extraction for ${chunks.length} chunks from: ${source}`);

    let totalEntities = 0;
    let totalRelationships = 0;
    let totalMentions = 0;

    // バッチサイズ：同時に処理するチャンク数
    const BATCH_SIZE = 8;
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

    console.log(`[GraphRAG] Processing ${chunks.length} chunks in ${totalBatches} batches (batch size: ${BATCH_SIZE})`);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * BATCH_SIZE;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, chunks.length);
      const batchChunks = chunks.slice(batchStart, batchEnd);

      // バッチ内のチャンクを並列処理
      const batchPromises = batchChunks.map(async (chunk) => {
        try {
          // Check if this chunk already has GraphRAG data
          const existingMentions = db.db.exec(
            'SELECT COUNT(*) as count FROM entity_mentions WHERE chunk_id = ?',
            [chunk.id]
          );
          const mentionCount = existingMentions[0]?.values[0]?.[0] || 0;

          if (mentionCount > 0) {
            console.log(`[GraphRAG] Chunk ${chunk.id} already has GraphRAG data, skipping`);
            return {
              success: true,
              chunkId: chunk.id,
              skipped: true,
              stats: { entities: 0, relationships: 0, mentions: 0 }
            };
          }

          // LLM関数を作成（モデル名を使用）
          const llmFunction = async (prompt) => {
            return await callLLMForExtraction(prompt, chatModel);
          };

          // エンティティと関係を抽出
          const extraction = await extractFromChunk(chunk.content, llmFunction);

          if (extraction) {
            // データベースに保存
            const stats = storeExtraction(db, chunk.id, extraction);
            return {
              success: true,
              chunkId: chunk.id,
              skipped: false,
              stats
            };
          }

          return {
            success: false,
            chunkId: chunk.id,
            skipped: false,
            stats: { entities: 0, relationships: 0, mentions: 0 }
          };
        } catch (error) {
          console.error(`[GraphRAG] Failed to extract from chunk ${chunk.id}:`, error);
          return {
            success: false,
            chunkId: chunk.id,
            skipped: false,
            error: error.message,
            stats: { entities: 0, relationships: 0, mentions: 0 }
          };
        }
      });

      // バッチ内の全処理を待機
      const batchResults = await Promise.all(batchPromises);

      // 統計情報を集計
      for (const result of batchResults) {
        totalEntities += result.stats.entities;
        totalRelationships += result.stats.relationships;
        totalMentions += result.stats.mentions;
      }

      // バッチごとに進捗表示
      const processedCount = batchEnd;
      const successCount = batchResults.filter(r => r.success && !r.skipped).length;
      const skippedCount = batchResults.filter(r => r.skipped).length;

      const progress = {
        processed: processedCount,
        total: chunks.length,
        successful: successCount,
        skipped: skippedCount,
        batchIndex: batchIndex + 1,
        totalBatches: totalBatches
      };

      console.log(
        `[GraphRAG] Batch ${progress.batchIndex}/${progress.totalBatches}: ` +
        `Processed ${progress.processed}/${progress.total} chunks ` +
        `(${successCount} successful, ${skippedCount} skipped in this batch)`
      );

      // Call progress callback if provided
      if (progressCallback) {
        progressCallback(progress);
      }
    }

    console.log(
      `[GraphRAG] Extraction complete: ${totalEntities} entities, ${totalRelationships} relationships, ${totalMentions} mentions`
    );

    // グラフ統計を表示
    const graphStats = db.getGraphStats();
    console.log(`[GraphRAG] Total graph size: ${graphStats.entities} entities, ${graphStats.relationships} relationships`);

    // GraphRAG: エンティティの埋め込みを生成して保存
    const embeddingModel = embedder.model;
    await generateEntityEmbeddings(db, embeddingModel);

    // 明示的にデータベースを保存して、すべてのデータが確実に永続化されるようにする
    db.save();
    console.log('[GraphRAG] Database saved after extraction completion');

    return {
      success: true,
      source,
      totalChunks: chunks.length,
      entities: totalEntities,
      relationships: totalRelationships,
      mentions: totalMentions
    };
  } catch (error) {
    console.error('[GraphRAG] Extraction failed:', error);
    throw error;
  }
}

/**
 * Get GraphRAG extraction progress for a document
 * @param {string} source - Document source path
 * @returns {Object} - Progress information
 */
function getGraphRAGProgress(source) {
  try {
    // データベースの初期化を確認
    if (!db.db) {
      throw new Error('Database not initialized');
    }

    // Get document ID
    const docIds = db.getDocumentIdsBySource(source);
    if (docIds.length === 0) {
      return {
        totalChunks: 0,
        processedChunks: 0,
        percentage: 0
      };
    }

    const docId = docIds[0];

    // Get total chunks count
    const totalResult = db.db.exec(
      'SELECT COUNT(*) as count FROM chunks WHERE document_id = ?',
      [docId]
    );
    const totalChunks = totalResult[0]?.values[0]?.[0] || 0;

    // Get processed chunks count (chunks with entity mentions)
    const processedResult = db.db.exec(
      `SELECT COUNT(DISTINCT c.id) as count
       FROM chunks c
       INNER JOIN entity_mentions em ON c.id = em.chunk_id
       WHERE c.document_id = ?`,
      [docId]
    );
    const processedChunks = processedResult[0]?.values[0]?.[0] || 0;

    const percentage = totalChunks > 0 ? Math.round((processedChunks / totalChunks) * 100) : 0;

    return {
      totalChunks,
      processedChunks,
      percentage
    };
  } catch (error) {
    console.error('[GraphRAG] Failed to get progress:', error);
    return {
      totalChunks: 0,
      processedChunks: 0,
      percentage: 0
    };
  }
}

async function saveChunksToFaiss(chunks) {
  const storePath = path.join(VECTOR_DIR, 'faiss_store');
  let docId = null; // エラー時のクリーンアップ用

  try {
    // データベースの初期化を確認
    if (!db.db) {
      await db.init();
    }

    // 1. SQLiteにドキュメントとチャンクを保存
    if (chunks.length === 0) {
      return;
    }

    const source = chunks[0].metadata.source;
    const embeddingModel = chunks[0].metadata.embeddingModel;

    console.log(`[DEBUG] [saveChunksToFaiss] Processing source: ${source}`);
    console.log(`[DEBUG] [saveChunksToFaiss] Embedding model: ${embeddingModel}`);
    console.log(`[DEBUG] [saveChunksToFaiss] Number of chunks: ${chunks.length}`);

    // ドキュメントをSQLiteに登録（既存の場合は古いチャンクを削除）
    const docResult = db.insertDocument(source, embeddingModel);
    docId = docResult.id;
    const documentExisted = docResult.existed;

    console.log(`[DEBUG] [saveChunksToFaiss] Document ID: ${docId}, existed: ${documentExisted}`);

    // 既存のドキュメントが存在した場合、FAISSから古いベクトルを削除
    if (documentExisted && vectorStore) {
      console.log(`[INFO] Replacing existing document: ${source}`);
      // FAISSを完全に再構築（古いchunk_idを持つベクトルを除外）
      try {
        const allDocs = await vectorStore.similaritySearch('', 9999);
        // 現在のdocumentに属さないドキュメントのみを保持
        const remainingDocs = allDocs.filter(doc => {
          const chunkSource = doc.metadata?.source;
          return chunkSource !== source;
        });

        if (remainingDocs.length > 0) {
          // 残りのドキュメントでvectorStoreを再構築
          vectorStore = await FaissStore.fromDocuments(remainingDocs, embedder);
          await vectorStore.save(storePath);
          console.log(`[INFO] Rebuilt FAISS store, removed old vectors for: ${source}`);
        } else {
          // すべてのドキュメントが削除される場合、vectorStoreをリセット
          vectorStore = null;
          if (fs.existsSync(storePath)) {
            fs.rmSync(storePath, { recursive: true, force: true });
          }
          console.log(`[INFO] Cleared FAISS store (no documents remaining after replacement)`);
        }
      } catch (rebuildError) {
        console.error('[ERROR] Failed to rebuild FAISS store:', rebuildError);
        // エラーが発生した場合、vectorStoreをnullにして新規作成を試みる
        vectorStore = null;
      }
    }

    // チャンクをSQLiteに保存し、chunk_idを取得
    const chunkIds = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkId = db.insertChunk(
        docId,
        i,
        chunk.pageContent,
        chunk.metadata.page || null
      );
      chunkIds.push(chunkId);
    }

    // SQLiteに保存
    db.save();

    console.log(`[INFO] Saved ${chunks.length} chunks to SQLite (GraphRAG extraction skipped)`);

    // 2. FAISSにはベクトルとchunk_idを保存（ベクトル生成のためにテキストは必要）
    const docsForFaiss = chunks.map((chunk, i) => ({
      pageContent: chunk.pageContent, // ベクトル生成に必要
      metadata: {
        ...chunk.metadata,
        chunk_id: chunkIds[i] // SQLiteのchunk_idを追加
      }
    }));

    if (!vectorStore) {
      // 既存のストアがあればロード、なければ新規作成
      if (fs.existsSync(storePath)) {
        vectorStore = await FaissStore.load(storePath, embedder);
        await vectorStore.addDocuments(docsForFaiss);
      } else {
        vectorStore = await FaissStore.fromDocuments(docsForFaiss, embedder);
      }
    } else {
      await vectorStore.addDocuments(docsForFaiss);
    }

    // ディスクに保存
    await vectorStore.save(storePath);

    console.log(`[INFO] Saved ${chunks.length} chunks from ${source} to SQLite and FAISS`);

    // Debug: Show total documents in vector store
    try {
      const allStoredDocs = await vectorStore.similaritySearch('', 10);
      const uniqueSources = new Set(allStoredDocs.map(doc => doc.metadata?.source?.split('/').pop() || 'unknown'));
      console.log(`[INFO] Vector store now contains ${allStoredDocs.length}+ chunks from ${uniqueSources.size} unique documents:`, Array.from(uniqueSources));
    } catch (debugError) {
      console.log('[DEBUG] Could not get vector store stats:', debugError.message);
    }
  } catch (error) {
    console.error('[ERROR] Failed to save chunks to vector store:', error);

    // エンベディング失敗の場合、不完全なベクトルストアをクリーンアップ
    if (error.message && (
      error.message.includes('Internal Server Error') ||
      error.message.includes('embedding') ||
      error.message.includes('dimensions') ||
      error.message.includes('500')
    )) {
      console.warn('[CLEANUP] Removing potentially corrupted vector store due to embedding failure');

      // vectorStoreをリセット
      vectorStore = null;

      // ディスク上のストアを削除
      try {
        if (fs.existsSync(storePath)) {
          fs.rmSync(storePath, { recursive: true, force: true });
          console.log('[CLEANUP] Successfully removed corrupted vector store');
        }
      } catch (cleanupError) {
        console.error('[CLEANUP] Failed to remove corrupted vector store:', cleanupError);
      }

      // SQLiteデータベースから不完全なデータを削除
      try {
        if (db && db.db && docId) {
          db.db.run('DELETE FROM chunks WHERE document_id = ?', [docId]);
          db.db.run('DELETE FROM documents WHERE id = ?', [docId]);
          db.save();
          console.log('[CLEANUP] Removed incomplete data from SQLite database');
        }
      } catch (dbCleanupError) {
        console.error('[CLEANUP] Failed to clean up SQLite database:', dbCleanupError);
      }

      // より詳細なエラーメッセージでre-throw
      const errorMessage = error.message || 'Unknown error';
      if (errorMessage.includes('Internal Server Error') || errorMessage.includes('500')) {
        throw new Error(
          `Embedding model failed with Ollama Internal Server Error.\n` +
          `The model "${embedder.model}" may not be suitable for embeddings or may not be properly installed.\n\n` +
          `Original error: ${errorMessage}\n\n` +
          `The vector store has been cleaned up. Please try again with a different embedding model.`
        );
      } else {
        throw new Error(
          `Failed to create embeddings: ${errorMessage}\n\n` +
          `The vector store has been cleaned up. Please try again.`
        );
      }
    }

    // その他のエラーはそのまま再スロー
    throw error;
  }
}

/*
async function saveChunksToFaiss(chunks, namespace) {

  if (fs.existsSync(`${VECTOR_DIR}/${namespace}`)) {
    vectorStore = await FaissStore.load(`${VECTOR_DIR}/${namespace}`, embedder);
    await store.addDocuments(chunks);
  } else {
    vectorStore = await FaissStore.fromDocuments(chunks, embedder);
  }

  await store.save(`${VECTOR_DIR}/${namespace}`);
}
*/

async function loadVectorStore() {
  // データベースの初期化
  await db.init();

  if (vectorStore) return;

  const storePath = path.join(VECTOR_DIR, 'faiss_store');

  // 既存のストアがあればロードする
  // ストアが存在しない場合はvectorStoreをnullのままにする
  // （最初のドキュメントが追加されたときにsaveChunksToFaissで初期化される）
  if (fs.existsSync(storePath)) {
    try {
      vectorStore = await FaissStore.load(storePath, embedder);
    } catch (error) {
      // 次元数ミスマッチなどのエラーが発生した場合
      if (error.message && error.message.includes('dimensions')) {
        console.error('[ERROR] Vector store dimension mismatch. Clearing incompatible store:', error.message);
        console.warn('[CLEANUP] Clearing both SQLite and FAISS stores due to dimension mismatch');

        // 互換性のないベクトルストアを削除
        try {
          fs.rmSync(storePath, { recursive: true, force: true });
          console.log('[CLEANUP] Deleted incompatible FAISS store');
        } catch (deleteError) {
          console.error('[ERROR] Failed to delete incompatible vector store:', deleteError);
        }
        vectorStore = null;

        // SQLiteもクリア
        try {
          db.db.run('DELETE FROM chunks');
          db.db.run('DELETE FROM documents');
          db.save();
          console.log('[CLEANUP] Cleared SQLite database');
        } catch (dbError) {
          console.error('[ERROR] Failed to clear SQLite database:', dbError);
        }
      } else {
        // その他のエラーは再スロー
        throw error;
      }
    }
  }

  // Load entity vector store for GraphRAG
  const entityStorePath = path.join(VECTOR_DIR, 'entity_faiss_store');
  if (fs.existsSync(entityStorePath)) {
    try {
      entityVectorStore = await FaissStore.load(entityStorePath, embedder);
      console.log('[GraphRAG] Entity vector store loaded');
    } catch (error) {
      console.warn('[GraphRAG] Failed to load entity vector store:', error);
      entityVectorStore = null;
    }
  }
}


// Embedding RAG: Vector similarity search using FAISS
async function searchFromStoreEmbedding(query, k = 3) {
  // データベースの初期化を確認
  if (!db.db) {
    await db.init();
  }

  if (!vectorStore) {
    // Try to load vector store if it exists
    const storePath = path.join(VECTOR_DIR, 'faiss_store');
    if (fs.existsSync(storePath)) {
      console.log('[INFO] Vector store not loaded, attempting to load now...');
      try {
        await loadVectorStore();
        if (!vectorStore) {
          throw new Error('Failed to load vector store after retry');
        }
      } catch (error) {
        console.error('[ERROR] Failed to load vector store:', error);
        throw new Error(
          `Vector store could not be loaded. This may be due to:\n` +
          `1. Embedding model mismatch (current: ${embedder.model})\n` +
          `2. Corrupted vector store\n` +
          `Please try re-uploading your documents.\n\n` +
          `Original error: ${error.message}`
        );
      }
    } else {
      throw new Error(
        'No vector store found. Please upload at least one document to use RAG.\n' +
        `Store path: ${storePath}`
      );
    }
  }

  try {
    // 1. FAISSからベクトル検索（chunk_idを取得）
    const faissResults = await vectorStore.similaritySearch(query, k);

    // Debug: Log sources returned by FAISS
    const faissSourceCounts = {};
    for (const result of faissResults) {
      const source = result.metadata?.source || 'unknown';
      const fileName = source.split('/').pop();
      faissSourceCounts[fileName] = (faissSourceCounts[fileName] || 0) + 1;
    }
    console.log(`[Search] FAISS returned ${faissResults.length} results from documents:`, faissSourceCounts);

    // 2. SQLiteからchunk_idを使ってテキストを取得
    const results = faissResults.map(result => {
      const chunkId = result.metadata?.chunk_id;
      if (!chunkId) {
        console.warn('[WARN] No chunk_id found in FAISS result, returning as-is');
        return result;
      }

      const chunk = db.getChunkById(chunkId);
      if (!chunk) {
        console.warn(`[WARN] Chunk not found in SQLite for chunk_id: ${chunkId}`);
        return result;
      }

      // テキストとメタデータを統合
      return {
        pageContent: chunk.content,
        metadata: {
          ...result.metadata,
          source: chunk.source,
          page: chunk.page
        }
      };
    });

    return results;
  } catch (error) {
    // 次元数ミスマッチエラーの場合は、より詳細なエラーメッセージを提供
    if (error.message && error.message.includes('dimensions')) {
      const storePath = path.join(VECTOR_DIR, 'faiss_store');
      console.warn('[CLEANUP] Clearing both SQLite and FAISS stores due to dimension mismatch');

      // 互換性のないベクトルストアを削除
      try {
        fs.rmSync(storePath, { recursive: true, force: true });
        vectorStore = null;
        console.log('[CLEANUP] Deleted incompatible FAISS store');
      } catch (deleteError) {
        console.error('[ERROR] Failed to delete incompatible vector store:', deleteError);
      }

      // SQLiteもクリア
      try {
        db.db.run('DELETE FROM chunks');
        db.db.run('DELETE FROM documents');
        db.save();
        console.log('[CLEANUP] Cleared SQLite database');
      } catch (dbError) {
        console.error('[ERROR] Failed to clear SQLite database:', dbError);
      }

      throw new Error(
        `Vector dimension mismatch detected. The existing vector store was created with a different embedding model ` +
        `and is incompatible with the current model (${embedder.model}). ` +
        `The incompatible store has been cleared. Please re-upload your documents.`
      );
    }
    // その他のエラーはそのまま再スロー
    throw error;
  }
}

/**
 * Rewrite query using LLM with chat context
 * @param {string} query - Current user query
 * @param {string} chatModel - Chat model name
 * @param {Array} chatHistory - Recent chat messages for context
 * @returns {Promise<string>} - Space-separated keywords
 */
async function rewriteQueryWithLLM(query, chatModel, chatHistory = []) {
  try {
    // Get last 3 messages for context (exclude system messages)
    const recentMessages = chatHistory
      .filter(m => m.role !== 'system')
      .slice(-3)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const contextPrompt = recentMessages
      ? `Chat history:\n${recentMessages}\n\nCurrent query: "${query}"\n\n`
      : `Query: "${query}"\n\n`;

    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        prompt: `${contextPrompt}Extract 3-7 important keywords for searching documents. Return ONLY keywords separated by spaces.

Example:
Query: "What is machine learning?"
Keywords: machine learning algorithms training data

Query: "それの応用例は？" (with context about AI)
Keywords: AI applications use cases examples

Now extract keywords from the current query above:`,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 50
        }
      })
    });

    if (!response.ok) {
      console.warn('[WARN] LLM query rewrite failed, using original query');
      return query;
    }

    const data = await response.json();
    console.log('[DEBUG] LLM response:', JSON.stringify(data, null, 2));

    // Some models (like gpt-oss) use "thinking" field for reasoning
    // Try response first, then thinking, then fallback to original query
    let rewrittenQuery = data.response ? data.response.trim() : '';

    if (!rewrittenQuery && data.thinking) {
      // Extract keywords from thinking field (after "keywords:" or similar)
      const thinkingText = data.thinking.toLowerCase();
      const keywordMatch = thinkingText.match(/keywords?:\s*(.+)/i);
      if (keywordMatch) {
        rewrittenQuery = keywordMatch[1].replace(/[,،]/g, ' ').trim();
      } else {
        // Use last part of thinking as it often contains the keywords
        const parts = data.thinking.split(/[.。]/);
        rewrittenQuery = parts[parts.length - 1].trim();
      }
    }

    // If empty or too short, fallback to original query
    if (!rewrittenQuery || rewrittenQuery.length < 3) {
      console.warn('[WARN] LLM returned empty/short response, using original query');
      return query;
    }

    // Clean up keywords: remove duplicates and very short words
    const keywords = rewrittenQuery.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length >= 3) // Min 3 chars
      .filter((word, index, arr) => arr.indexOf(word) === index); // Remove duplicates

    const cleanedQuery = keywords.join(' ');
    console.log(`[INFO] Query rewritten: "${query}" -> "${cleanedQuery}"`);
    return cleanedQuery;
  } catch (error) {
    console.warn('[WARN] LLM query rewrite error:', error.message);
    return query;
  }
}

// Full-text search RAG: Keyword-based search with LLM query rewriting
async function searchFromStoreFullText(query, k = 3, chatModel = null, chatHistory = []) {
  if (!db.db) {
    await db.init();
  }

  try {
    // LLMでクエリをリライト（コンテキスト考慮）
    let searchQuery = query;
    if (chatModel) {
      searchQuery = await rewriteQueryWithLLM(query, chatModel, chatHistory);
    }

    // LIKE検索（スコアリング付き）
    const ftsResults = db.fullTextSearch(searchQuery, k);

    // Langchain Document形式に変換
    const results = ftsResults.map(chunk => ({
      pageContent: chunk.content,
      metadata: {
        source: chunk.source,
        page: chunk.page,
        embeddingModel: chunk.embedding_model,
        score: chunk.score
      }
    }));

    return results;
  } catch (error) {
    console.error('[ERROR] Full-text search failed:', error);
    throw error;
  }
}

// Hybrid RAG: Combines embedding and full-text search
async function searchFromStoreHybrid(query, k = 3, chatModel = null, chatHistory = []) {
  // データベースの初期化を確認
  if (!db.db) {
    await db.init();
  }

  try {
    // 両方の検索を並列実行
    const [embeddingResults, fullTextResults] = await Promise.all([
      searchFromStoreEmbedding(query, k).catch(() => []),
      searchFromStoreFullText(query, k, chatModel, chatHistory).catch(() => [])
    ]);

    // 結果をマージして重複を削除
    const seenChunks = new Set();
    const mergedResults = [];

    // エンベディング結果を優先（より高い重み）
    for (const result of embeddingResults) {
      const key = `${result.metadata.source}-${result.pageContent.substring(0, 50)}`;
      if (!seenChunks.has(key)) {
        seenChunks.add(key);
        mergedResults.push(result);
      }
    }

    // 全文検索結果を追加（まだ含まれていないもののみ）
    for (const result of fullTextResults) {
      const key = `${result.metadata.source}-${result.pageContent.substring(0, 50)}`;
      if (!seenChunks.has(key) && mergedResults.length < k * 2) {
        seenChunks.add(key);
        mergedResults.push(result);
      }
    }

    // 最大k個の結果を返す
    return mergedResults.slice(0, k);
  } catch (error) {
    console.error('[ERROR] Hybrid search failed:', error);
    throw error;
  }
}

/**
 * Main search function with RAG mode selection and GraphRAG integration
 * @param {string} query - Search query
 * @param {number} k - Number of results
 * @param {Object} options - Search options
 * @param {string} options.mode - RAG mode: 'embedding', 'fulltext', or 'hybrid'
 * @param {boolean} options.useChunkRAG - Whether to use chunk-based RAG
 * @param {boolean} options.useGraphRAG - Whether to use GraphRAG
 * @param {string} options.chatModel - Chat model for query rewriting
 * @param {Array} options.chatHistory - Chat history for context
 * @returns {Promise<Array>} Search results
 */
async function searchFromStore(query, k = 3, options = {}) {
  const {
    mode = 'embedding',
    useChunkRAG = true,
    useGraphRAG = false,
    chatModel = null,
    chatHistory = []
  } = options;

  console.log(`[Search] Mode: ${mode}, ChunkRAG: ${useChunkRAG}, GraphRAG: ${useGraphRAG}`);

  let allResults = [];

  // Chunk-based RAG (通常RAG)
  if (useChunkRAG) {
    try {
      let chunkResults = [];

      if (mode === 'embedding') {
        chunkResults = await searchFromStoreEmbedding(query, k);
      } else if (mode === 'fulltext') {
        chunkResults = await searchFromStoreFullText(query, k, chatModel, chatHistory);
      } else if (mode === 'hybrid') {
        chunkResults = await searchFromStoreHybrid(query, k, chatModel, chatHistory);
      }

      console.log(`[Search] Chunk RAG found ${chunkResults.length} results`);
      allResults = allResults.concat(chunkResults);
    } catch (error) {
      console.error('[Search] Chunk RAG failed:', error);
    }
  }

  // GraphRAG (Entity-based RAG)
  if (useGraphRAG) {
    try {
      const graphResults = await graphRagSearch({
        db,
        entityVectorStore,
        query,
        topEntities: 3,
        maxRelated: 5,
        maxChunks: k
      });

      console.log(`[Search] GraphRAG found ${graphResults.chunks.length} chunks from ${graphResults.entities.length} entities`);

      // Convert GraphRAG chunks to standard format
      const graphChunks = graphResults.chunks.map(chunk => ({
        pageContent: chunk.content,
        metadata: {
          source: chunk.source,
          page: chunk.page,
          chunk_index: chunk.chunk_index,
          chunk_id: chunk.id,
          entity_names: chunk.entity_names,
          entity_types: chunk.entity_types,
          entity_count: chunk.entity_count,
          graphrag: true // Mark as GraphRAG result
        }
      }));

      allResults = allResults.concat(graphChunks);
    } catch (error) {
      console.error('[Search] GraphRAG failed:', error);
    }
  }

  // Deduplicate results by chunk_id
  const seenChunkIds = new Set();
  const deduplicatedResults = [];

  for (const result of allResults) {
    const chunkId = result.metadata?.chunk_id;
    if (chunkId && !seenChunkIds.has(chunkId)) {
      seenChunkIds.add(chunkId);
      deduplicatedResults.push(result);
    } else if (!chunkId) {
      // No chunk_id (shouldn't happen, but include anyway)
      deduplicatedResults.push(result);
    }
  }

  // Log document sources for debugging
  const sourceCounts = {};
  for (const result of deduplicatedResults) {
    const source = result.metadata?.source || 'unknown';
    const fileName = source.split('/').pop();
    sourceCounts[fileName] = (sourceCounts[fileName] || 0) + 1;
  }
  console.log(`[Search] Returning ${deduplicatedResults.length} deduplicated results from documents:`, sourceCounts);

  return deduplicatedResults.slice(0, k * 2); // Return up to 2x requested for diversity
}

/*
async function getStoredSources() {
  if (!vectorStore) {
    await loadVectorStore(); // ← 明示的に呼ぶ場合
  }
  const allDocs = await vectorStore.similaritySearch('', 9999); // 空検索で全件取得
  const sources = new Set();
  for (const doc of allDocs) {
    if (doc.metadata?.source) {
      sources.add(doc.metadata.source);
    }
  }
  return Array.from(sources);
}
*/

async function getStoredSources() {
  try {
    // データベースの初期化を確認
    if (!db.db) {
      await db.init();
    }

    // FAISSのロードを試みて、次元ミスマッチエラーを早期検出
    if (!vectorStore) {
      const storePath = path.join(VECTOR_DIR, 'faiss_store');
      if (fs.existsSync(storePath)) {
        try {
          vectorStore = await FaissStore.load(storePath, embedder);
        } catch (error) {
          // 次元数ミスマッチエラーの場合は、両方のストアをクリア
          if (error.message && error.message.includes('dimensions')) {
            console.error('[ERROR] Vector store dimension mismatch in getStoredSources:', error.message);
            console.warn('[CLEANUP] Clearing both SQLite and FAISS stores due to dimension mismatch');

            // FAISSを削除
            try {
              fs.rmSync(storePath, { recursive: true, force: true });
              vectorStore = null;
              console.log('[CLEANUP] Deleted incompatible FAISS store');
            } catch (deleteError) {
              console.error('[ERROR] Failed to delete incompatible vector store:', deleteError);
            }

            // SQLiteもクリア
            try {
              db.db.run('DELETE FROM chunks');
              db.db.run('DELETE FROM documents');
              db.save();
              console.log('[CLEANUP] Cleared SQLite database');
            } catch (dbError) {
              console.error('[ERROR] Failed to clear SQLite database:', dbError);
            }

            return [];
          }
          throw error;
        }
      }
    }

    // SQLiteから取得（高速）
    return db.getStoredSources();
  } catch (error) {
    console.error('[ERROR] Failed to get stored sources:', error);
    return [];
  }
}

async function deleteDocumentFromStore(sourcePath) {
  const storePath = path.join(VECTOR_DIR, 'faiss_store');

  try {
    // データベースの初期化を確認
    if (!db.db) {
      await db.init();
    }

    // 1. SQLiteから削除対象のchunk_idを取得
    const docIds = db.getDocumentIdsBySource(sourcePath);
    if (docIds.length === 0) {
      console.log(`[INFO] No documents found for source: ${sourcePath}`);
      return;
    }

    const chunkIds = db.getChunkIdsByDocumentIds(docIds);
    console.log(`[INFO] Deleting ${chunkIds.length} chunks for document: ${sourcePath}`);

    // 2. FAISSから削除
    if (vectorStore) {
      // Get all documents from the store
      const allDocs = await vectorStore.similaritySearch('', 9999);

      // Filter out documents that match the chunk_ids
      const remainingDocs = allDocs.filter(
        doc => !chunkIds.includes(doc.metadata?.chunk_id)
      );

      // Recreate vector store with remaining documents
      if (remainingDocs.length > 0) {
        vectorStore = await FaissStore.fromDocuments(remainingDocs, embedder);
        await vectorStore.save(storePath);
        console.log(`[INFO] Updated FAISS store, ${remainingDocs.length} chunks remaining`);
      } else {
        // If no documents remain, delete the store files
        vectorStore = null;
        if (fs.existsSync(storePath)) {
          fs.rmSync(storePath, { recursive: true, force: true });
          console.log('[INFO] Deleted FAISS store (no documents remaining)');
        }
      }
    }

    // 3. SQLiteから削除（CASCADEで関連チャンクも自動削除）
    db.deleteDocumentBySource(sourcePath);

    // 4. GraphRAG: 孤立したエンティティと関係のクリーンアップ
    db.cleanupOrphanedGraphData();

    db.save();

    console.log(`[INFO] Successfully deleted document: ${sourcePath}`);
  } catch (error) {
    console.error('[ERROR] Failed to delete document:', error);
    throw error;
  }
}

function saveSourceMeta(filePath) {
  const fileName = path.basename(filePath);
  let list = [];
  if (fs.existsSync(LIST_PATH)) {
    list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf-8'));
  }
  if (!list.includes(fileName)) {
    list.push(fileName);
    fs.writeFileSync(LIST_PATH, JSON.stringify(list, null, 2), 'utf-8');
  }
}

async function extractTextFromPDF(filePath) {
    const data = new Uint8Array(fs.readFileSync(filePath));
    // isEvalSupported: false を設定して GHSA-wgrm-67xf-hhpq 脆弱性を軽減
    const pdf = await pdfjsLib.getDocument({
      data,
      isEvalSupported: false
    }).promise;

    const pages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      pages.push({ pageNum, text: pageText });
    }

    return pages;
  }

async function readAndSplit(filePath) {

  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
}
  const ext = path.extname(filePath).toLowerCase();
  const embeddingModel = embedder.model; // 現在使用中のembeddingモデル

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 100,
  });

  let rawDocs = [];

  if (ext === '.txt') {
    const rawText = fs.readFileSync(filePath, 'utf-8');
    rawDocs.push(new Document({
      pageContent: rawText,
      metadata: { source: filePath, embeddingModel },
    }));
  } else if (ext === '.md') {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const rawText = matter(raw).content;
    rawDocs.push(new Document({
      pageContent: rawText,
      metadata: { source: filePath, embeddingModel },
    }));
  } else if (ext === '.pdf') {
    const pages = await extractTextFromPDF(filePath);
    // ページごとにDocumentを作成
    rawDocs = pages.map(p => new Document({
      pageContent: p.text,
      metadata: { source: filePath, page: p.pageNum, embeddingModel },
    }));
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const chunks = await splitter.splitDocuments(rawDocs);
  return chunks;
}


console.log('[DEBUG] Preload script loaded');
console.log('[DEBUG] electronAPI available:', typeof window !== 'undefined');

contextBridge.exposeInMainWorld('electronAPI', {
  readAndSplit,
  saveChunksToFaiss,
  getStoredSources,
  saveSourceMeta,
  searchFromStore,
  searchFromStoreEmbedding,
  searchFromStoreFullText,
  searchFromStoreHybrid,
  loadVectorStore,
  setEmbedderModel,
  getCurrentEmbedderModel: () => embedder.model,
  deleteDocumentFromStore,
  checkEmbedModelExists,
  extractGraphRAGForDocument,
  getGraphRAGProgress,
  openFileDialog: () => {
    console.log('[DEBUG] openFileDialog called in preload');
    return ipcRenderer.invoke('open-file-dialog');
  },
  openManageRAGWindow: () => ipcRenderer.invoke('open-manage-rag-window'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  onServerError: (callback) => ipcRenderer.on('server-error', (_event, data) => callback(data)),
  onGraphRAGProgress: (callback) => ipcRenderer.on('graphrag-progress', (_event, data) => callback(data)),
  onEmbedModelChanged: (callback) => ipcRenderer.on('embed-model-changed', (_event, modelName) => callback(modelName)),
  notifyEmbedModelChanged: (modelName) => ipcRenderer.send('embed-model-changed', modelName),
  onRequestCurrentEmbedModel: (callback) => ipcRenderer.on('request-current-embed-model', callback),
});

console.log('[DEBUG] electronAPI.openFileDialog:', typeof window.electronAPI?.openFileDialog);

// embed-model-changedイベントを受け取って、embedderを更新
ipcRenderer.on('embed-model-changed', (_event, modelName) => {
  console.log('[INFO] Embedding model changed event received in preload:', modelName);
  // embedderオブジェクトを更新（但しsetEmbedderModelは呼ばない、DBのクリアは不要なため）
  if (embedder.model !== modelName) {
    embedder = new OllamaEmbeddings({ model: modelName });
    console.log('[INFO] Updated embedder object to:', modelName);
  }
});

// Preload時にベクターストアをバックグラウンドでロード
loadVectorStore().catch(() => {
  // Silent fail
});