const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
let PORT = 3000;
let serverPort = null; // 実際に使用されているポート

app.use(cors());
app.use(bodyParser.json());

const http = require('http');

app.post('/chat-stream', (req, res) => {
  const {
    messages,
    temperature = 0.7,
    top_p = 0.9,
    top_k = 40,
    seed = 42,
    model
  } = req.body;

  if (!model || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'model and messages[] required' });
  }

  /*const messages = [];
  if (system_prompt) {
    messages.push({ role: 'system', content: system_prompt });
  }
  messages.push({ role: 'user', content: prompt });
  */

  const ollamaReq = http.request(
    {
      hostname: 'localhost',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    },
    ollamaRes => {
      res.setHeader('Content-Type', 'text/plain'); // Streamとして返す
      ollamaRes.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (!line.trim().startsWith('{')) continue;
          const json = JSON.parse(line);
          if (json.message?.content) res.write(json.message.content);
        }
      });
      ollamaRes.on('end', () => res.end());
    }
  );

  ollamaReq.on('error', () => {
    res.status(500).end('Ollama stream error');
  });

  //const fullPrompt = system_prompt ? `${system_prompt}\n\n${prompt}` : prompt;

  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    options: {
      temperature,
      top_p,
      top_k,
      seed,
    }
  });

  ollamaReq.write(body);
  ollamaReq.end();
});

app.get('/models', async (req, res) => {
  try {
    const response = await axios.get('http://localhost:11434/api/tags');
    const models = response.data.models.map(m => m.name);
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: 'Ollama API not responding. Please make sure Ollama is running.' });
  }
});

// Get all models (no filtering)
app.get('/embedding-models', async (req, res) => {
  try {
    const response = await axios.get('http://localhost:11434/api/tags');
    const models = response.data.models.map(m => m.name);
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: 'Ollama API not responding. Please make sure Ollama is running.' });
  }
});

// ポートを自動的に選択してサーバーを起動
function startServer(port, maxRetries = 10) {
  const server = app.listen(port, () => {
    serverPort = port;
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxRetries > 0) {
      startServer(port + 1, maxRetries - 1);
    } else {
      // Electronのメインプロセスにエラーを通知
      if (global.mainWindow) {
        global.mainWindow.webContents.send('server-error', {
          message: 'Failed to start internal server',
          error: err.message
        });
      }
    }
  });

  return server;
}

startServer(PORT);

// 使用中のポートを取得する関数をエクスポート
module.exports = {
  getPort: () => {
    return serverPort;
  }
};
