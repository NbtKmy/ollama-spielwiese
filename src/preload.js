const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist');
pdfjsLib.GlobalWorkerOptions.workerSrc = require('pdfjs-dist/build/pdf.worker.entry');
const matter = require('gray-matter');
//const { FaissStore } = require('langchain/vectorstores/faiss');
const { Document } = require('langchain/document');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const { OllamaEmbeddings } = require('@langchain/ollama');
const { MemoryVectorStore } = require('langchain/vectorstores/memory');


const embedder = new OllamaEmbeddings({
  model: 'bge-m3', // ← または bge-m3, mxbai-embed-large など
});

let vectorStore = null;
const VECTOR_DIR = path.join(__dirname, '../vector-db');
const LIST_PATH = path.join(__dirname, '../vector-db/sources.json');

async function saveChunksToMemory(chunks) {
  console.log('[RAG] Saving', chunks.length, 'chunks');
  if (!vectorStore) {
    vectorStore = await MemoryVectorStore.fromDocuments(chunks, embedder);
  } else {
    await vectorStore.addDocuments(chunks);
  }
  console.log('[DEBUG] vectorStore after save:', vectorStore);
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

  // create dummy store
  vectorStore = await MemoryVectorStore.fromDocuments([], embedder);
  console.log('[RAG] Initialized empty MemoryVectorStore');
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
    console.warn('[RAG] vectorStore is empty (null)');
    return [];
  }

  const allDocs = await vectorStore.similaritySearch('', 9999);
  console.log(allDocs.map(d => d.pageContent.slice(0, 100)));
  const sources = new Set();

  for (const doc of allDocs) {
    if (doc.metadata?.source) {
      sources.add(doc.metadata.source);
      console.log('[RAG] doc.metadata:', doc.metadata);
    }
  }

  return Array.from(sources);
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

/*
function loadSourceMeta() {
  if (!fs.existsSync(LIST_PATH)) return [];
  return JSON.parse(fs.readFileSync(LIST_PATH, 'utf-8'));
}
*/

async function extractTextFromPDF(filePath) {
    const data = new Uint8Array(fs.readFileSync(filePath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
  
    let text = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      text += pageText + '\n';
    }
  
    return text;
  }

async function readAndSplit(filePath) {
  
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Invalid file path');
}
  const ext = path.extname(filePath).toLowerCase();

  let rawText = '';
  if (ext === '.txt') {
    rawText = fs.readFileSync(filePath, 'utf-8');
  } else if (ext === '.md') {
    const raw = fs.readFileSync(filePath, 'utf-8');
    rawText = matter(raw).content;
  } else if (ext === '.pdf') {
    rawText = await extractTextFromPDF(filePath);
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 100,
  });

  const rawDoc = new Document({
    pageContent: rawText,
    metadata: { source: filePath },
  });

  const chunks = await splitter.splitDocuments([rawDoc]);
  console.log('[DEBUG] chunk metadata:', chunks[0]?.metadata);
  return chunks;
}

contextBridge.exposeInMainWorld('ragAPI', {
  readAndSplit,
  saveChunksToMemory,
  getStoredSources,
  saveSourceMeta,
  searchFromStore,
  loadVectorStore,
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
});


contextBridge.exposeInMainWorld('electronAPI', {
  openRagWindow: () => ipcRenderer.invoke('open-rag-window'),
});