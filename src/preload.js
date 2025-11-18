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


let embedder = new OllamaEmbeddings({
  model: 'bge-m3',
});

// メインプロセスから渡された環境変数を使用
const VECTOR_DIR = process.env.VECTOR_DB_PATH || path.join(__dirname, '../vector-db');

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


let vectorStore = null;
let db = null;

const LIST_PATH = path.join(VECTOR_DIR, 'sources.json');

// vector-dbディレクトリが存在しない場合は作成
if (!fs.existsSync(VECTOR_DIR)) {
  fs.mkdirSync(VECTOR_DIR, { recursive: true });
}

// Initialize database
const DB_PATH = path.join(VECTOR_DIR, 'documents.db');
db = new Database(DB_PATH);

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

    console.log(`[INFO] Saved ${chunks.length} chunks to SQLite and FAISS`);
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
}


// Embedding RAG: Vector similarity search using FAISS
async function searchFromStoreEmbedding(query, k = 3) {
  // データベースの初期化を確認
  if (!db.db) {
    await db.init();
  }

  if (!vectorStore) throw new Error('No vector store loaded');

  try {
    // 1. FAISSからベクトル検索（chunk_idを取得）
    const faissResults = await vectorStore.similaritySearch(query, k);

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

// Backward compatibility: default to embedding search
async function searchFromStore(query, k = 3) {
  return searchFromStoreEmbedding(query, k);
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
  openFileDialog: () => {
    console.log('[DEBUG] openFileDialog called in preload');
    return ipcRenderer.invoke('open-file-dialog');
  },
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  onServerError: (callback) => ipcRenderer.on('server-error', (_event, data) => callback(data)),
});

console.log('[DEBUG] electronAPI.openFileDialog:', typeof window.electronAPI?.openFileDialog);

// Preload時にベクターストアをバックグラウンドでロード
loadVectorStore().catch(() => {
  // Silent fail
});