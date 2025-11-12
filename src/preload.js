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
  return { success: true };
}

async function getExistingModels() {
  if (!vectorStore) {
    return [];
  }

  const allDocs = await vectorStore.similaritySearch('', 9999);
  const models = new Set();

  for (const doc of allDocs) {
    if (doc.metadata?.embeddingModel) {
      models.add(doc.metadata.embeddingModel);
    }
  }

  return Array.from(models);
}


let vectorStore = null;

// メインプロセスから渡された環境変数を使用
const VECTOR_DIR = process.env.VECTOR_DB_PATH || path.join(__dirname, '../vector-db');
const LIST_PATH = path.join(VECTOR_DIR, 'sources.json');

// vector-dbディレクトリが存在しない場合は作成
if (!fs.existsSync(VECTOR_DIR)) {
  fs.mkdirSync(VECTOR_DIR, { recursive: true });
}

async function saveChunksToFaiss(chunks) {
  const storePath = path.join(VECTOR_DIR, 'faiss_store');

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

  // 既存のストアがあればロード
  if (fs.existsSync(storePath)) {
    vectorStore = await FaissStore.load(storePath, embedder);
  } else {
    // なければ空のストアを作成
    vectorStore = await FaissStore.fromDocuments([], embedder);
  }
}


async function searchFromStore(query, k = 3) {
  if (!vectorStore) throw new Error('No vector store loaded');
  return await vectorStore.similaritySearch(query, k);
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
    const pdf = await pdfjsLib.getDocument({ data }).promise;

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
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  onServerError: (callback) => ipcRenderer.on('server-error', (_event, data) => callback(data)),
});

// Preload時にベクターストアをバックグラウンドでロード
loadVectorStore().catch(() => {
  // Silent fail
});