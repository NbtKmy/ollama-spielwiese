let messages = [];
let isChatActive = false;

async function loadModels() {
    try {
      const res = await fetch('http://localhost:3000/models');
      const data = await res.json();
      const select = document.getElementById('model-select');
  
      data.models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        select.appendChild(option);
      });
    } catch (err) {
      console.error('Error retrieving model list:', err);
    }
  }
  
  window.addEventListener('DOMContentLoaded', () => {
    loadModels();
  
    document.getElementById('send').addEventListener('click', async () => {
      const prompt = document.getElementById('prompt').value;
      const systemPrompt = document.getElementById('system-prompt').value;
  
      const model = document.getElementById('model-select').value;
      const temperature = parseFloat(document.getElementById('temperature').value);
      const top_p = parseFloat(document.getElementById('top_p').value);
      const top_k = parseInt(document.getElementById('top_k').value);
      const seed = parseInt(document.getElementById('seed').value);

      if (!isChatActive) {
        messages = [];
        if (systemPrompt) {
          messages.push({ role: 'system', content: systemPrompt });
        }
        isChatActive = true;
        lockParamsUI(true);
      }

      appendMessage('user', prompt);
      messages.push({ role: 'user', content: prompt });
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