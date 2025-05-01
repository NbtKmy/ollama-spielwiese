import '../public/style.css';

let messages = [];
let isChatActive = false;

async function loadModels() {
    try {
      const res = await fetch('http://localhost:3000/models');
      const data = await res.json();
      const select = document.getElementById('model-select');
      const embedSelect = document.getElementById('embed-model');

  
      data.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;

        select.appendChild(option);
        embedSelect.appendChild(option.cloneNode(true));
        
      });
    } catch (err) {
      console.error('Error retrieving model list:', err);
    }
  }
  
  window.addEventListener('DOMContentLoaded', async () => {
    await window.electronAPI.loadVectorStore();
    loadModels();
  
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
        const results = await window.electronAPI.searchFromStore(prompt);
        // console.log('[RAG] 検索結果:', results);
        if (results.length === 0) {
            alert('Reference information not found. Send as normal chat.');
            messages.push({ role: 'user', content: prompt });
          } else {
            const context = results.map(doc => doc.pageContent).join('\n---\n');
            // Get source information from metadata
            const sources = [...new Set(results.map(doc => doc.metadata?.source).filter(Boolean))];
            citations = sources.map(src => `・${src.split('/').pop()}`).join('\n');
            messages.push({
                role: 'user',
                content: `Answer the question based on the following references:\n${context}\n\nQuestion: ${prompt}`
              });
          }
      } else {
        messages.push({
          role: 'user',
          content: prompt
        });
      }
      //messages.push({ role: 'user', content: prompt });
      document.getElementById('prompt').value = '';
  
      const res = await fetch('http://localhost:3000/chat-stream', {
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
    const paths = await window.electronAPI.openFileDialog();
    for (const filePath of paths) {
      const chunks = await window.electronAPI.readAndSplit(filePath);
      await window.electronAPI.saveChunksToMemory(chunks);
    }
    await refreshRagFileList();
  });


document.getElementById('rag-file-input').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files);
    for (const file of files) {
      const chunks = await window.electronAPI.readAndSplit(file.path);
      await window.electronAPI.saveChunksToMemory(chunks);
    }
    await refreshRagFileList(); // ← 画面右の文書一覧更新
  });

async function refreshRagFileList() {
    const list = document.getElementById('rag-file-list');
    list.innerHTML = '';
    const sources = await window.electronAPI.getStoredSources();
    for (const file of sources) {
      const li = document.createElement('li');
      li.textContent = file.split('/').pop();
      list.appendChild(li);
    }
  }

document.getElementById('embed-model').addEventListener('change', (e) => {
    const selected = e.target.value;
    window.electronAPI.setEmbedderModel(selected);
  });