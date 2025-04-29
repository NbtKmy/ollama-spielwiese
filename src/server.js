const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = 3000;

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

  ollamaReq.on('error', err => {
    console.error('Stream error:', err.message);
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
    console.error('Error retrieving model list:', err.message);
    res.status(500).json({ error: 'Model list cannot be retrieved from Ollama' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Express API running at http://localhost:${PORT}`);
});
