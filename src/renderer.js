import '../public/style.css';

let messages = [];
let isChatActive = false;
let serverPort = null; // サーバーポートをキャッシュ

async function getServerPort() {
  if (!serverPort) {
    serverPort = await window.electronAPI.getServerPort();
  }
  return serverPort;
}

async function loadModels() {
    try {
      const port = await getServerPort();
      if (!port) {
        throw new Error('Server port not available. Internal server may not have started.');
      }
      const res = await fetch(`http://localhost:${port}/models`);

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const data = await res.json();
      const select = document.getElementById('model-select');
      const embedSelect = document.getElementById('embed-model');


      // Get current embedding model first
      const currentEmbedModel = window.electronAPI.getCurrentEmbedderModel();

      data.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;

        select.appendChild(option);
        embedSelect.appendChild(option.cloneNode(true));

      });

      // If current embedding model is not in the list, add it
      if (!data.models.includes(currentEmbedModel)) {
        const option = document.createElement('option');
        option.value = currentEmbedModel;
        option.textContent = currentEmbedModel;
        embedSelect.appendChild(option);
      }

      // Set current embedding model as default
      embedSelect.value = currentEmbedModel;
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
      if (useRag) {
        // Check if embedding model exists in Ollama
        const modelCheck = await window.electronAPI.checkEmbedModelExists();
        if (!modelCheck.exists) {
          alert(
            `⚠️ Embedding Model Not Available\n\n` +
            `RAG (Retrieval-Augmented Generation) requires an embedding model, but "${modelCheck.currentModel}" is not installed in Ollama.\n\n` +
            `To use RAG, please install the embedding model:\n` +
            `  ollama pull ${modelCheck.currentModel}\n\n` +
            `Or select a different embedding model from the available models in the settings panel.\n\n` +
            `Proceeding with normal chat without RAG.`
          );
          messages.push({ role: 'user', content: prompt });
        } else {
          const results = await window.electronAPI.searchFromStore(prompt);
          if (results.length === 0) {
              alert('Reference information not found. Send as normal chat.');
              messages.push({ role: 'user', content: prompt });
            } else {
              const context = results.map(doc => doc.pageContent).join('\n---\n');
              // Get source information with page numbers
              const sourceInfo = results.map(doc => {
                const fileName = doc.metadata?.source || 'Unknown';
                const pageNum = doc.metadata?.page;
                return pageNum ? `${fileName} (p.${pageNum})` : fileName;
              });
              // Remove duplicates while preserving order
              const uniqueSources = [...new Set(sourceInfo)];
              citations = uniqueSources.map(src => `・${src}`).join('\n');
              messages.push({
                  role: 'user',
                  content: `Answer the question based on the following references:\n${context}\n\nQuestion: ${prompt}`
                });
            }
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
  
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantReply = '';
      const assistantEntry = createMessageEntry('assistant');
  
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        assistantReply += chunk;
        assistantEntry.textContent = assistantReply;
      }
      
      if (citations) {
        assistantReply += `\n\n📎 Source:\n${citations}`;
        assistantEntry.textContent = assistantReply; 
      }

      messages.push({ role: 'assistant', content: assistantReply });
    });

    // ベクターストアをバックグラウンドでロード（失敗してもUIには影響しない）
    try {
      await window.electronAPI.loadVectorStore();
      await refreshRagFileList();
    } catch (error) {
      console.error('Failed to load vector store:', error);
    }
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

document.getElementById('use-rag').addEventListener('click', async () => {
    // Check if embedding model exists in Ollama
    const modelCheck = await window.electronAPI.checkEmbedModelExists();
    if (!modelCheck.exists) {
      alert(
        `⚠️ Embedding Model Not Available\n\n` +
        `Cannot upload documents for RAG. The embedding model "${modelCheck.currentModel}" is not installed in Ollama.\n\n` +
        `To use RAG, please install the embedding model:\n` +
        `  ollama pull ${modelCheck.currentModel}\n\n` +
        `Or select a different embedding model from the available models in the settings panel.`
      );
      return;
    }

    const paths = await window.electronAPI.openFileDialog();
    for (const filePath of paths) {
      const chunks = await window.electronAPI.readAndSplit(filePath);
      await window.electronAPI.saveChunksToFaiss(chunks);
    }
    await refreshRagFileList();
  });


document.getElementById('rag-file-input').addEventListener('change', async (event) => {
    // Check if embedding model exists in Ollama
    const modelCheck = await window.electronAPI.checkEmbedModelExists();
    if (!modelCheck.exists) {
      alert(
        `⚠️ Embedding Model Not Available\n\n` +
        `Cannot upload documents for RAG. The embedding model "${modelCheck.currentModel}" is not installed in Ollama.\n\n` +
        `To use RAG, please install the embedding model:\n` +
        `  ollama pull ${modelCheck.currentModel}\n\n` +
        `Or select a different embedding model from the available models in the settings panel.`
      );
      // Reset the file input
      event.target.value = '';
      return;
    }

    const files = Array.from(event.target.files);
    for (const file of files) {
      const chunks = await window.electronAPI.readAndSplit(file.path);
      await window.electronAPI.saveChunksToFaiss(chunks);
    }
    await refreshRagFileList(); // ← 画面右の文書一覧更新
  });

async function refreshRagFileList() {
    const list = document.getElementById('rag-file-list');
    list.innerHTML = '';
    const sources = await window.electronAPI.getStoredSources();
    for (const item of sources) {
      const li = document.createElement('li');
      li.className = 'rag-file-item';

      const fileInfo = document.createElement('div');
      fileInfo.className = 'file-info';

      const fileName = document.createElement('span');
      fileName.textContent = item.source.split('/').pop();
      fileName.className = 'file-name';

      const modelName = document.createElement('span');
      modelName.textContent = `(${item.models.join(', ')})`;
      modelName.className = 'model-name';
      modelName.style.fontSize = '0.85em';
      modelName.style.color = '#666';
      modelName.style.marginLeft = '8px';

      fileInfo.appendChild(fileName);
      fileInfo.appendChild(modelName);

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '🗑️';
      deleteBtn.className = 'delete-btn';
      deleteBtn.title = 'Delete this document';
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to delete "${item.source.split('/').pop()}"?`)) {
          try {
            await window.electronAPI.deleteDocumentFromStore(item.source);
            await refreshRagFileList();
          } catch (error) {
            alert(`Failed to delete document: ${error.message}`);
          }
        }
      };

      li.appendChild(fileInfo);
      li.appendChild(deleteBtn);
      list.appendChild(li);
    }
  }

document.getElementById('embed-model').addEventListener('change', async (e) => {
    const selected = e.target.value;
    const result = await window.electronAPI.setEmbedderModel(selected);

    if (!result.success) {
      const existingModelsStr = result.existingModels.join(', ');
      const confirmChange = confirm(
        `⚠️ Embedding Model Compatibility Warning\n\n` +
        `Existing documents use: ${existingModelsStr}\n` +
        `You are switching to: ${result.newModel}\n\n` +
        `Different embedding models create incompatible vector spaces.\n` +
        `This means:\n` +
        `• New documents will not be properly compared with existing ones\n` +
        `• Search results may be inaccurate\n\n` +
        `Recommendation: Delete all existing documents before switching,\n` +
        `or continue using the same model.\n\n` +
        `Do you want to switch anyway?`
      );

      if (!confirmChange) {
        // モデル選択を元に戻す
        e.target.value = result.existingModels[0];
        return;
      }

      // 強制的に切り替え（forceフラグをtrue）
      await window.electronAPI.setEmbedderModel(selected, true);
    }
  });