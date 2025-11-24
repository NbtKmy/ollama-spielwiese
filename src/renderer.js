import '../public/style.css';
import { marked } from 'marked';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false
});

let messages = [];
let isChatActive = false;
let serverPort = null; // サーバーポートをキャッシュ

// Common embedding models known to work well
const COMMON_EMBEDDING_MODELS = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'bge-m3',
  'bge-large',
  'snowflake-arctic-embed',
  'all-minilm',
  'paraphrase-multilingual'
];

async function getServerPort() {
  if (!serverPort) {
    serverPort = await window.electronAPI.getServerPort();
  }
  return serverPort;
}

// Check if the model is a recognized embedding model
function isRecommendedEmbeddingModel(modelName) {
  return COMMON_EMBEDDING_MODELS.some(commonModel =>
    modelName.toLowerCase().includes(commonModel.toLowerCase())
  );
}

async function loadModels() {
    try {
      const port = await getServerPort();
      if (!port) {
        throw new Error('Server port not available. Internal server may not have started.');
      }

      // Load chat models
      const chatRes = await fetch(`http://localhost:${port}/models`);
      if (!chatRes.ok) {
        throw new Error(`HTTP error! status: ${chatRes.status}`);
      }
      const chatData = await chatRes.json();
      const select = document.getElementById('model-select');

      chatData.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        select.appendChild(option);
      });

      // Load embedding models only
      const embedRes = await fetch(`http://localhost:${port}/embedding-models`);
      if (!embedRes.ok) {
        throw new Error(`HTTP error! status: ${embedRes.status}`);
      }
      const embedData = await embedRes.json();
      const embedSelect = document.getElementById('embed-model');
      const currentEmbedModel = window.electronAPI.getCurrentEmbedderModel();

      embedData.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        embedSelect.appendChild(option);
      });

      // Set current embedding model as default
      if (embedData.models.length > 0 && embedData.models.includes(currentEmbedModel)) {
        embedSelect.value = currentEmbedModel;
      } else if (embedData.models.length > 0) {
        embedSelect.value = embedData.models[0];
      }
    } catch (err) {
      alert(`⚠️ Ollama API Not Responding\n\nThe application could not connect to Ollama.\n\nPlease make sure:\n1. Ollama is running (http://localhost:11434)\n2. At least one model is installed\n\nError details: ${err.message}`);
    }
  }
  
  window.addEventListener('DOMContentLoaded', async () => {
    loadModels();

    // サーバーエラー時の通知を受け取る
    window.electronAPI.onServerError((data) => {
      alert(`Server Error: ${data.message}\n\nDetails: ${data.error}\n\nThe application may not work correctly.`);
    });

    // イベントリスナーを先に登録（これが最も重要）
    document.getElementById('send').addEventListener('click', async () => {
      const prompt = document.getElementById('prompt').value;
      const systemPrompt = document.getElementById('system-prompt').value;
  
      const model = document.getElementById('model-select').value;
      const temperature = parseFloat(document.getElementById('temperature').value);
      const top_p = parseFloat(document.getElementById('top_p').value);
      const top_k = parseInt(document.getElementById('top_k').value);
      const seed = parseInt(document.getElementById('seed').value);
      const useRag = document.getElementById('use-rag-checkbox').checked;

      if (!isChatActive) {
        messages = [];
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }
        isChatActive = true;
        lockParamsUI(true);
      }
      let citations = '';
      appendMessage('user', prompt);

      // Show typing indicator immediately (before RAG search)
      const assistantEntry = createMessageEntry('assistant');
      assistantEntry.innerHTML = '<div style="display: flex; align-items: center; gap: 8px;"><div class="typing-indicator"><span></span><span></span><span></span></div><span style="color: #374151; font-weight: 500;">Thinking...</span></div>';
      let isFirstChunk = true;

      if (useRag) {
        try {
          // Get RAG settings
          const useChunkRAG = document.getElementById('use-rag-checkbox').checked;
          const useGraphRAG = document.getElementById('use-graphrag-checkbox').checked;
          const ragMode = document.querySelector('input[name="rag-mode"]:checked').value;

          console.log('[DEBUG] RAG Settings:', { useChunkRAG, useGraphRAG, ragMode });

          // Call unified search function with options
          const results = await window.electronAPI.searchFromStore(prompt, 3, {
            mode: ragMode,
            useChunkRAG: useChunkRAG,
            useGraphRAG: useGraphRAG,
            chatModel: model,
            chatHistory: messages
          });

          if (results.length === 0) {
            alert('Reference information not found. Send as normal chat.');
            messages.push({ role: 'user', content: prompt });
          } else {
            const context = results.map(doc => doc.pageContent).join('\n---\n');

            // Get source information with page numbers and entity info
            const sourceInfo = results.map(doc => {
              const fullPath = doc.metadata?.source || 'Unknown';
              const fileName = fullPath.split('/').pop();
              const pageNum = doc.metadata?.page;
              let info = pageNum ? `${fileName} (p.${pageNum})` : fileName;

              // Add entity information for GraphRAG results
              if (doc.metadata?.graphrag && doc.metadata?.entity_names?.length > 0) {
                const entityLabels = doc.metadata.entity_names.map((name, idx) => {
                  const type = doc.metadata.entity_types?.[idx];
                  return type ? `${name} (${type})` : name;
                });
                info += ` [🕸️ ${entityLabels.join(', ')}]`;
              }

              return info;
            });

            // Remove duplicates while preserving order
            const uniqueSources = [...new Set(sourceInfo)];
            citations = uniqueSources.map(src => `・${src}`).join('\n');

            messages.push({
              role: 'user',
              content: `Answer the question based on the following references:\n${context}\n\nQuestion: ${prompt}`
            });
          }
        } catch (error) {
          alert(
            `⚠️ RAG Search Failed\n\n` +
            `Error: ${error.message}\n\n` +
            `This may happen if:\n` +
            `• The embedding model used for stored documents is no longer available\n` +
            `• The selected embedding model is not suitable for embeddings\n\n` +
            `Proceeding with normal chat without RAG.\n` +
            `Please check your embedding model settings or re-upload documents with a proper embedding model.`
          );
          messages.push({ role: 'user', content: prompt });
        }
      } else {
        messages.push({
          role: 'user',
          content: prompt
        });
      }
      //messages.push({ role: 'user', content: prompt });
      document.getElementById('prompt').value = '';

      const port = await getServerPort();
      if (!port) {
        alert('Internal server not available. Cannot send message.');
        return;
      }

      try {
        const res = await fetch(`http://localhost:${port}/chat-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            top_p,
            top_k,
            seed
          }),
        });

        // Check if the response is ok
        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Ollama API Error (${res.status}): ${errorText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let assistantReply = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);

          // Remove typing indicator on first chunk
          if (isFirstChunk) {
            assistantEntry.innerHTML = '';
            isFirstChunk = false;
          }

          assistantReply += chunk;
          // Render markdown to HTML
          assistantEntry.innerHTML = marked.parse(assistantReply);
        }

        if (citations) {
          assistantReply += `\n\n📎 Source:\n${citations}`;
          // Render markdown to HTML
          assistantEntry.innerHTML = marked.parse(assistantReply);
        }

        messages.push({ role: 'assistant', content: assistantReply });
      } catch (error) {
        console.error('[ERROR] Chat stream failed:', error);

        // Remove typing indicator and show error
        assistantEntry.innerHTML = '<span style="color: #ef4444;">Error: Failed to get response</span>';

        // Display error message to user
        const errorMessage = error.message || 'Unknown error';
        alert(
          `⚠️ Chat Request Failed\n\n` +
          `Error: ${errorMessage}\n\n` +
          `Common causes:\n` +
          `• Insufficient RAM for the selected model\n` +
          `• Ollama service is not responding\n` +
          `• The model is not properly loaded\n` +
          `• Network connection issue\n\n` +
          `Try:\n` +
          `• Using a smaller model\n` +
          `• Restarting Ollama\n` +
          `• Checking Ollama status at http://localhost:11434`
        );

        // Remove the last user message since the request failed
        if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
          messages.pop();
        }
      }
    });

    // ベクターストアをバックグラウンドでロード（失敗してもUIには影響しない）
    try {
      await window.electronAPI.loadVectorStore();
    } catch (error) {
      console.error('Failed to load vector store:', error);
    }

    // Manage RAG Documents button
    document.getElementById('manage-rag').addEventListener('click', async () => {
      try {
        await window.electronAPI.openManageRAGWindow();
      } catch (error) {
        console.error('[ERROR] Failed to open Manage RAG window:', error);
        alert(`Failed to open Manage RAG window: ${error.message}`);
      }
    });

    // REMOVED: Old Load PDF for RAG button code
    /*
    document.getElementById('use-rag').addEventListener('click', async () => {
      console.log('[DEBUG] Load PDF button clicked');
      const loadingIndicator = document.getElementById('pdf-loading');
      try {
        // Show loading indicator
        loadingIndicator.classList.remove('hidden');
        // 現在選択されているembedding modelを取得
        const selectedEmbedModel = document.getElementById('embed-model').value;
        console.log('[DEBUG] Selected embed model:', selectedEmbedModel);

        // embedding modelを設定（forceフラグはfalse、互換性チェックを行う）
        const setResult = await window.electronAPI.setEmbedderModel(selectedEmbedModel, false);

        if (!setResult.success) {
          // モデルの互換性警告
          const existingModelsStr = setResult.existingModels.join(', ');
          const confirmChange = confirm(
            `⚠️ Embedding Model Change Warning\n\n` +
            `Existing documents use: ${existingModelsStr}\n` +
            `You are trying to use: ${setResult.newModel}\n\n` +
            `IMPORTANT: Switching the embedding model will make all existing vector store data unusable.\n` +
            `All existing documents will become inaccessible and cannot be searched.\n\n` +
            `Different embedding models create incompatible vector spaces with different dimensions.\n` +
            `You will need to:\n` +
            `• Delete all existing documents from the list on the right\n` +
            `• Re-upload all documents with the new embedding model\n\n` +
            `Recommendation: Delete all existing documents before switching,\n` +
            `or use the same model (${existingModelsStr}) as existing documents.\n\n` +
            `Do you want to continue anyway and make existing data unusable?`
          );

          if (!confirmChange) {
            return; // キャンセルされた場合は処理を中止
          }

          // 強制的に切り替え
          await window.electronAPI.setEmbedderModel(selectedEmbedModel, true);
        }

        // エンベディングモデルの存在確認
        console.log('[DEBUG] Checking embedding model existence...');
        const modelCheck = await window.electronAPI.checkEmbedModelExists();
        console.log('[DEBUG] Model check result:', modelCheck);

        if (!modelCheck.exists) {
          console.error('[ERROR] Model check failed:', modelCheck);
          alert(
            `⚠️ Embedding Model Not Found\n\n` +
            `The selected embedding model "${modelCheck.currentModel}" is not installed in Ollama.\n\n` +
            `Available models:\n${modelCheck.availableModels?.join('\n') || 'None'}\n\n` +
            `Error: ${modelCheck.error || 'Unknown error'}\n\n` +
            `Please install the model using:\n` +
            `ollama pull ${modelCheck.currentModel}\n\n` +
            `Or select a different embedding model from the dropdown.`
          );
          return;
        }

        // Check if the model is a recognized embedding model
        if (!isRecommendedEmbeddingModel(selectedEmbedModel)) {
          const confirmUseNonEmbedModel = confirm(
            `⚠️ Non-Standard Embedding Model Detected\n\n` +
            `You selected: ${selectedEmbedModel}\n\n` +
            `This model is not a standard embedding model. While Ollama technically allows ` +
            `any model to generate embeddings, using a regular LLM may result in:\n` +
            `• Lower quality vector representations\n` +
            `• Inefficient performance\n` +
            `• Unpredictable search accuracy\n\n` +
            `Recommended embedding models:\n` +
            `${COMMON_EMBEDDING_MODELS.map(m => `• ${m}`).join('\n')}\n\n` +
            `Do you want to continue with "${selectedEmbedModel}" anyway?`
          );

          if (!confirmUseNonEmbedModel) {
            return; // User cancelled
          }
        }

        console.log('[DEBUG] Model check passed, opening file dialog...');
        console.log('[DEBUG] Calling window.electronAPI.openFileDialog()');
        const paths = await window.electronAPI.openFileDialog();
        console.log('[DEBUG] File dialog returned:', paths);
        if (!paths || paths.length === 0) {
          console.log('[DEBUG] No files selected');
          return; // ファイルが選択されなかった場合は処理を中止
        }

        console.log('[DEBUG] Number of files selected:', paths.length);

        for (let i = 0; i < paths.length; i++) {
          const filePath = paths[i];
          console.log(`[DEBUG] Processing file ${i + 1}/${paths.length}:`, filePath);
          const chunks = await window.electronAPI.readAndSplit(filePath);
          console.log(`[DEBUG] Generated ${chunks.length} chunks for file:`, filePath);
          console.log(`[DEBUG] First chunk source:`, chunks[0]?.metadata?.source);
          await window.electronAPI.saveChunksToFaiss(chunks);
          console.log(`[DEBUG] Saved chunks to FAISS for file:`, filePath);
        }
        await refreshRagFileList();
        // Hide loading indicator on success
        loadingIndicator.classList.add('hidden');
      } catch (error) {
        console.error('[ERROR] Failed to process document:', error);
        // Hide loading indicator on error
        loadingIndicator.classList.add('hidden');

        // Ollamaのエラーかどうかをチェック
        const errorMessage = error.message || 'Unknown error';
        const isOllamaError = errorMessage.includes('Internal Server Error') ||
                             errorMessage.includes('Ollama') ||
                             errorMessage.includes('500');

        if (isOllamaError) {
          // Ollamaのエラーの場合、より詳細な情報を表示
          alert(
            `⚠️ Embedding Failed - Ollama Error\n\n` +
            `${errorMessage}\n\n` +
            `Common causes:\n` +
            `• The selected model is not an embedding model\n` +
            `• The model is not properly installed in Ollama\n` +
            `• Ollama service is not responding correctly\n\n` +
            `Recommended embedding models:\n` +
            `• mxbai-embed-large\n` +
            `• bge-m3\n` +
            `• nomic-embed-text\n` +
            `• bge-large\n\n` +
            `The vector store has been automatically cleaned up.\n` +
            `Please select a different embedding model and try again.`
          );
        } else {
          // その他のエラー
          alert(
            `⚠️ Failed to Process Document\n\n` +
            `Error: ${errorMessage}\n\n` +
            `This may happen if:\n` +
            `• The selected embedding model is not suitable for embeddings\n` +
            `• The embedding model is not installed in Ollama\n` +
            `• The file format is not supported\n\n` +
            `Please select a proper embedding model (e.g., mxbai-embed-large, bge-m3, nomic-embed-text) and try again.`
          );
        }
      }
    });
    */

    // REMOVED: Old RAG file input code
    /*
    // RAG file input
    document.getElementById('rag-file-input').addEventListener('change', async (event) => {
      const loadingIndicator = document.getElementById('pdf-loading');
      try {
        // Show loading indicator
        loadingIndicator.classList.remove('hidden');
        // 現在選択されているembedding modelを取得
        const selectedEmbedModel = document.getElementById('embed-model').value;

        // embedding modelを設定（forceフラグはfalse、互換性チェックを行う）
        const setResult = await window.electronAPI.setEmbedderModel(selectedEmbedModel, false);

        if (!setResult.success) {
          // モデルの互換性警告
          const existingModelsStr = setResult.existingModels.join(', ');
          const confirmChange = confirm(
            `⚠️ Embedding Model Change Warning\n\n` +
            `Existing documents use: ${existingModelsStr}\n` +
            `You are trying to use: ${setResult.newModel}\n\n` +
            `IMPORTANT: Switching the embedding model will make all existing vector store data unusable.\n` +
            `All existing documents will become inaccessible and cannot be searched.\n\n` +
            `Different embedding models create incompatible vector spaces with different dimensions.\n` +
            `You will need to:\n` +
            `• Delete all existing documents from the list on the right\n` +
            `• Re-upload all documents with the new embedding model\n\n` +
            `Recommendation: Delete all existing documents before switching,\n` +
            `or use the same model (${existingModelsStr}) as existing documents.\n\n` +
            `Do you want to continue anyway and make existing data unusable?`
          );

          if (!confirmChange) {
            return; // キャンセルされた場合は処理を中止
          }

          // 強制的に切り替え
          await window.electronAPI.setEmbedderModel(selectedEmbedModel, true);
        }

        // エンベディングモデルの存在確認
        console.log('[DEBUG] [file-input] Checking embedding model existence...');
        const modelCheck = await window.electronAPI.checkEmbedModelExists();
        console.log('[DEBUG] [file-input] Model check result:', modelCheck);

        if (!modelCheck.exists) {
          console.error('[ERROR] [file-input] Model check failed:', modelCheck);
          alert(
            `⚠️ Embedding Model Not Found\n\n` +
            `The selected embedding model "${modelCheck.currentModel}" is not installed in Ollama.\n\n` +
            `Available models:\n${modelCheck.availableModels?.join('\n') || 'None'}\n\n` +
            `Error: ${modelCheck.error || 'Unknown error'}\n\n` +
            `Please install the model using:\n` +
            `ollama pull ${modelCheck.currentModel}\n\n` +
            `Or select a different embedding model from the dropdown.`
          );
          return;
        }

        // Check if the model is a recognized embedding model
        if (!isRecommendedEmbeddingModel(selectedEmbedModel)) {
          const confirmUseNonEmbedModel = confirm(
            `⚠️ Non-Standard Embedding Model Detected\n\n` +
            `You selected: ${selectedEmbedModel}\n\n` +
            `This model is not a standard embedding model. While Ollama technically allows ` +
            `any model to generate embeddings, using a regular LLM may result in:\n` +
            `• Lower quality vector representations\n` +
            `• Inefficient performance\n` +
            `• Unpredictable search accuracy\n\n` +
            `Recommended embedding models:\n` +
            `${COMMON_EMBEDDING_MODELS.map(m => `• ${m}`).join('\n')}\n\n` +
            `Do you want to continue with "${selectedEmbedModel}" anyway?`
          );

          if (!confirmUseNonEmbedModel) {
            event.target.value = ''; // Reset file input
            return; // User cancelled
          }
        }

        console.log('[DEBUG] [file-input] Model check passed, processing files...');
        const files = Array.from(event.target.files);
        console.log('[DEBUG] [file-input] Number of files selected:', files.length);

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          console.log(`[DEBUG] [file-input] Processing file ${i + 1}/${files.length}:`, file.path);
          const chunks = await window.electronAPI.readAndSplit(file.path);
          console.log(`[DEBUG] [file-input] Generated ${chunks.length} chunks for file:`, file.path);
          console.log(`[DEBUG] [file-input] First chunk source:`, chunks[0]?.metadata?.source);
          await window.electronAPI.saveChunksToFaiss(chunks);
          console.log(`[DEBUG] [file-input] Saved chunks to FAISS for file:`, file.path);
        }
        await refreshRagFileList(); // ← 画面右の文書一覧更新
        // Hide loading indicator on success
        loadingIndicator.classList.add('hidden');
      } catch (error) {
        console.error('[ERROR] [file-input] Failed to process document:', error);
        // Hide loading indicator on error
        loadingIndicator.classList.add('hidden');

        // より詳細なエラーメッセージを提供
        const errorMessage = error.message || 'Unknown error';
        const isOllamaError = errorMessage.includes('Internal Server Error') ||
                             errorMessage.includes('Ollama') ||
                             errorMessage.includes('500');

        if (isOllamaError) {
          // Ollama specific error - embedding model failure
          alert(
            `⚠️ Embedding Failed - Ollama Error\n\n` +
            `${errorMessage}\n\n` +
            `Common causes:\n` +
            `• The selected model is not an embedding model\n` +
            `• The model is not properly installed in Ollama\n` +
            `• Ollama service is not responding correctly\n\n` +
            `Recommended embedding models:\n` +
            `• mxbai-embed-large\n` +
            `• bge-m3\n` +
            `• nomic-embed-text\n` +
            `• bge-large\n\n` +
            `The vector store has been automatically cleaned up.\n` +
            `Please select a different embedding model and try again.`
          );
        } else {
          // Generic error message for other errors
          alert(
            `⚠️ Failed to Process Document\n\n` +
            `Error: ${errorMessage}\n\n` +
            `This may happen if:\n` +
            `• The file format is not supported\n` +
            `• The file is corrupted or unreadable\n` +
            `• There was an unexpected error during processing\n\n` +
            `Supported file formats: PDF, TXT, MD\n\n` +
            `Please check the file and try again.`
          );
        }
      } finally {
        // Reset the file input
        event.target.value = '';
      }
    });
    */

    // Embedding model change handler
    document.getElementById('embed-model').addEventListener('change', async (e) => {
      const selected = e.target.value;
      const result = await window.electronAPI.setEmbedderModel(selected);

      if (!result.success) {
        const existingModelsStr = result.existingModels.join(', ');
        const confirmChange = confirm(
          `⚠️ Embedding Model Change Warning\n\n` +
          `Existing documents use: ${existingModelsStr}\n` +
          `You are switching to: ${result.newModel}\n\n` +
          `IMPORTANT: If you switch the embedding model, all existing vector store data will be deleted.\n` +
          `You will need to re-upload all documents with the new model.\n\n` +
          `Different embedding models create incompatible vector spaces with different dimensions.\n` +
          `This means:\n` +
          `• Existing documents cannot be searched with the new model\n` +
          `• All stored vectors will be deleted automatically\n` +
          `• You must re-process all documents from scratch\n\n` +
          `Recommendation: Continue using the same model (${existingModelsStr})\n` +
          `unless you specifically need to change it.\n\n` +
          `Do you want to switch anyway and delete all existing data?`
        );

        if (!confirmChange) {
          // モデル選択を元に戻す
          e.target.value = result.existingModels[0];
          return;
        }

        // 強制的に切り替え（forceフラグをtrue）
        await window.electronAPI.setEmbedderModel(selected, true);
      }

      // Note: File list refresh removed since PDF management moved to separate window
    });
  });

function lockParamsUI(lock) {
    const fields = ['model-select', 'temperature', 'top_p', 'top_k', 'seed', 'system-prompt'];
    fields.forEach(id => {
        const el = document.getElementById(id);
        el.disabled = lock;
        el.style.opacity = lock ? 0.5 : 1;
    });
}

function appendMessage(role, text) {
    const log = document.getElementById('chat-log');
    const entry = document.createElement('div');
    entry.className = role; // ← class名でスタイル適用
  
    const strong = document.createElement('strong');
    strong.textContent = `${role === 'user' ? '🧑‍💻 User' : '🤖 Assistant'}:`;
    const content = document.createElement('div');
    content.textContent = text;
  
    entry.appendChild(strong);
    entry.appendChild(content);
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
  }

function createMessageEntry(role) {
    const log = document.getElementById('chat-log');
    const entry = document.createElement('div');
    entry.className = role; 
    const strong = document.createElement('strong');
    strong.textContent = `${role === 'user' ? '🧑‍💻 User' : '🤖 Assistant'}:`;
    const content = document.createElement('div');
    
    entry.appendChild(strong);
    entry.appendChild(content);

    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;

    return content;
}

function resetChat() {
    messages = [];
    isChatActive = false;
    lockParamsUI(false);
    document.getElementById('chat-log').innerHTML = '';
    document.getElementById('prompt').value = '';
  }

window.resetChat = resetChat;

function exportChat() {
    const systemPrompt = document.getElementById('system-prompt').value;
    const model = document.getElementById('model-select').value;
    const temperature = parseFloat(document.getElementById('temperature').value);
    const top_p = parseFloat(document.getElementById('top_p').value);
    const top_k = parseInt(document.getElementById('top_k').value);
    const seed = parseInt(document.getElementById('seed').value);
  
    const data = {
      model,
      systemPrompt,
      parameters: { temperature, top_p, top_k, seed },
      history: messages
    };
  
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `chat-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
  }
window.exportChat = exportChat;

// REMOVED: refreshRagFileList function - moved to manage-rag.js