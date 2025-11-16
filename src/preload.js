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


let embedder = new OllamaEmbeddings({
  model: 'bge-m3',
});

// メインプロセスから渡された環境変数を使用
const VECTOR_DIR = process.env.VECTOR_DB_PATH || path.join(__dirname, '../vector-db');

async function setEmbedderModel(name, force = false) {
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
      console.log('[INFO] Deleted existing vector store due to embedding model change');
    }
  } catch (error) {
    console.error('[ERROR] Failed to delete vector store:', error);
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

const LIST_PATH = path.join(VECTOR_DIR, 'sources.json');

// vector-dbディレクトリが存在しない場合は作成
if (!fs.existsSync(VECTOR_DIR)) {
  fs.mkdirSync(VECTOR_DIR, { recursive: true });
}

async function saveChunksToFaiss(chunks) {
  const storePath = path.join(VECTOR_DIR, 'faiss_store');

  try {
    if (!vectorStore) {
      // 既存のストアがあればロード、なければ新規作成
      if (fs.existsSync(storePath)) {
        vectorStore = await FaissStore.load(storePath, embedder);
        await vectorStore.addDocuments(chunks);
      } else {
        vectorStore = await FaissStore.fromDocuments(chunks, embedder);
      }
    } else {
      await vectorStore.addDocuments(chunks);
    }

    // ディスクに保存
    await vectorStore.save(storePath);
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
        // 互換性のないベクトルストアを削除
        try {
          fs.rmSync(storePath, { recursive: true, force: true });
        } catch (deleteError) {
          console.error('[ERROR] Failed to delete incompatible vector store:', deleteError);
        }
        vectorStore = null;
      } else {
        // その他のエラーは再スロー
        throw error;
      }
    }
  }
}


async function searchFromStore(query, k = 3) {
  if (!vectorStore) throw new Error('No vector store loaded');

  try {
    return await vectorStore.similaritySearch(query, k);
  } catch (error) {
    // 次元数ミスマッチエラーの場合は、より詳細なエラーメッセージを提供
    if (error.message && error.message.includes('dimensions')) {
      const storePath = path.join(VECTOR_DIR, 'faiss_store');
      // 互換性のないベクトルストアを削除
      try {
        fs.rmSync(storePath, { recursive: true, force: true });
        vectorStore = null;
      } catch (deleteError) {
        console.error('[ERROR] Failed to delete incompatible vector store:', deleteError);
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
  if (!vectorStore) {
    return [];
  }

  try {
    const allDocs = await vectorStore.similaritySearch('', 9999);
    // ファイルごとのメタ情報をMapで管理
    const sourceMap = new Map();

    for (const doc of allDocs) {
      if (doc.metadata?.source) {
        const source = doc.metadata.source;
        const model = doc.metadata.embeddingModel || 'unknown';

        // 既存エントリがない、または異なるモデルが見つかった場合
        if (!sourceMap.has(source)) {
          sourceMap.set(source, { models: new Set([model]) });
        } else {
          sourceMap.get(source).models.add(model);
        }
      }
    }

    // Map → Array変換（モデルリストを配列化）
    return Array.from(sourceMap.entries()).map(([source, info]) => ({
      source,
      models: Array.from(info.models)
    }));
  } catch (error) {
    // 次元数ミスマッチエラーの場合は、ストアをクリア
    if (error.message && error.message.includes('dimensions')) {
      console.error('[ERROR] Vector store dimension mismatch in getStoredSources:', error.message);
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

async function deleteDocumentFromStore(sourcePath) {
  if (!vectorStore) {
    return;
  }

  const storePath = path.join(VECTOR_DIR, 'faiss_store');

  // Get all documents from the store
  const allDocs = await vectorStore.similaritySearch('', 9999);

  // Filter out documents that match the source path
  const remainingDocs = allDocs.filter(doc => doc.metadata?.source !== sourcePath);

  // Recreate vector store with remaining documents
  if (remainingDocs.length > 0) {
    vectorStore = await FaissStore.fromDocuments(remainingDocs, embedder);
    // ディスクに保存
    await vectorStore.save(storePath);
  } else {
    // If no documents remain, delete the store files and set vectorStore to null
    vectorStore = null;

    // Delete the store directory if it exists
    if (fs.existsSync(storePath)) {
      fs.rmSync(storePath, { recursive: true, force: true });
    }
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
  const fileName = path.basename(filePath);
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
      metadata: { source: fileName, embeddingModel },
    }));
  } else if (ext === '.md') {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const rawText = matter(raw).content;
    rawDocs.push(new Document({
      pageContent: rawText,
      metadata: { source: fileName, embeddingModel },
    }));
  } else if (ext === '.pdf') {
    const pages = await extractTextFromPDF(filePath);
    // ページごとにDocumentを作成
    rawDocs = pages.map(p => new Document({
      pageContent: p.text,
      metadata: { source: fileName, page: p.pageNum, embeddingModel },
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