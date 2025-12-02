// Manage RAG window JavaScript

// Common embedding models
const COMMON_EMBEDDING_MODELS = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'bge-m3',
  'bge-large',
  'snowflake-arctic-embed',
  'all-minilm',
  'paraphrase-multilingual'
];

// Global state
let selectedChatModel = null;
let isExtracting = false;
let shouldStopExtraction = false;
let currentExtractingPdf = null;

// Check if the model is a recognized embedding model
function isRecommendedEmbeddingModel(modelName) {
  return COMMON_EMBEDDING_MODELS.some(commonModel =>
    modelName.toLowerCase().includes(commonModel.toLowerCase())
  );
}

// Toggle extraction buttons visibility
function updateExtractionButtons(extracting) {
  const extractBtn = document.getElementById('extract-all-btn');
  const stopBtn = document.getElementById('stop-extract-btn');

  if (extracting) {
    extractBtn.style.display = 'none';
    stopBtn.style.display = 'block';
  } else {
    extractBtn.style.display = 'block';
    stopBtn.style.display = 'none';
  }
}

// Get available models from Ollama
async function getServerPort() {
  return await window.electronAPI.getServerPort();
}

// Update statistics in the left panel
function updateStatistics(sources) {
  const totalDocs = sources.length;
  const extractedDocs = sources.filter(item => {
    const progress = window.electronAPI.getGraphRAGProgress(item.source);
    return progress.percentage === 100;
  }).length;

  document.getElementById('stat-total-docs').textContent = totalDocs;
  document.getElementById('stat-extracted-docs').textContent = extractedDocs;
}

async function loadChatModels() {
  try {
    const port = await getServerPort();
    if (!port) {
      throw new Error('Server port not available');
    }

    const response = await fetch(`http://localhost:${port}/models`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error('[ERROR] Failed to load chat models:', error);
    return [];
  }
}

async function loadEmbeddingModels() {
  try {
    const port = await getServerPort();
    if (!port) {
      throw new Error('Server port not available');
    }

    const response = await fetch(`http://localhost:${port}/embedding-models`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error('[ERROR] Failed to load embedding models:', error);
    return [];
  }
}

// Refresh document list
async function refreshDocumentList() {
  const documentList = document.getElementById('document-list');

  try {
    const sources = await window.electronAPI.getStoredSources();

    // Update statistics
    updateStatistics(sources);

    if (sources.length === 0) {
      documentList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📭</div>
          <p>No documents uploaded yet</p>
          <p style="font-size: 12px; margin-top: 5px;">Click "Upload Documents" to get started</p>
        </div>
      `;
      return;
    }

    documentList.innerHTML = '';

    for (const item of sources) {
      const fileName = item.source.split('/').pop();
      const progress = window.electronAPI.getGraphRAGProgress(item.source);

      const documentItem = document.createElement('div');
      documentItem.className = 'document-item';
      documentItem.dataset.source = item.source;

      const isExtracted = progress.percentage === 100;
      const isPartiallyExtracted = progress.percentage > 0 && progress.percentage < 100;
      const isCurrentlyExtracting = currentExtractingPdf === item.source;
      const isWaiting = isExtracting && !isExtracted && !isCurrentlyExtracting;

      // Determine button state and text
      let buttonDisabled = isExtracted || isExtracting;
      let buttonText;

      if (isExtracted) {
        buttonText = '✓ GraphRAG Extracted';
      } else if (isCurrentlyExtracting) {
        buttonText = '⏳ Extracting...';
      } else if (isWaiting) {
        buttonText = '⏸ Waiting...';
      } else if (isPartiallyExtracted) {
        buttonText = '⟳ Continue Extraction';
      } else {
        buttonText = '🕸️ Extract GraphRAG';
      }

      documentItem.innerHTML = `
        <div class="document-header">
          <div>
            <div class="document-name" title="${fileName}">${fileName}</div>
            <div class="document-meta">
              Model: ${item.models.join(', ')}
              ${progress.totalChunks > 0 ? `• Chunks: ${progress.totalChunks}` : ''}
            </div>
          </div>
        </div>
        <div class="document-actions">
          <button class="btn btn-small btn-extract" data-source="${item.source}" ${buttonDisabled ? 'disabled' : ''}>
            ${buttonText}
          </button>
          <button class="btn btn-small btn-delete" data-source="${item.source}">
            🗑️ Delete
          </button>
        </div>
        <div class="progress-container" id="progress-${item.source.replace(/[^a-zA-Z0-9]/g, '_')}">
          <div class="progress-bar-container">
            <div class="progress-bar" style="width: ${progress.percentage}%">
              ${progress.percentage}%
            </div>
          </div>
          <div class="progress-text">
            Processed: ${progress.processedChunks} / ${progress.totalChunks} chunks
          </div>
        </div>
      `;

      documentList.appendChild(documentItem);

      // Check if document name needs fade-out effect
      const documentNameEl = documentItem.querySelector('.document-name');
      if (documentNameEl) {
        // Use requestAnimationFrame to ensure the element is fully rendered
        requestAnimationFrame(() => {
          const isOverflowing = documentNameEl.scrollWidth > documentNameEl.clientWidth;
          if (isOverflowing) {
            documentNameEl.classList.add('fade-out');
          }
        });
      }
    }

    // Add event listeners for extract buttons
    document.querySelectorAll('.btn-extract').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const source = e.target.dataset.source;
        await extractGraphRAG(source);
      });
    });

    // Add event listeners for delete buttons
    document.querySelectorAll('.btn-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const source = e.target.dataset.source;
        const fileName = source.split('/').pop();

        if (confirm(`Are you sure you want to delete "${fileName}"?\n\nThis will remove the document and all associated GraphRAG data.`)) {
          try {
            await window.electronAPI.deleteDocumentFromStore(source);
            await refreshDocumentList();
          } catch (error) {
            alert(`Failed to delete document: ${error.message}`);
          }
        }
      });
    });
  } catch (error) {
    console.error('[ERROR] Failed to refresh document list:', error);
    documentList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <p>Failed to load documents</p>
        <p style="font-size: 12px; margin-top: 5px;">${error.message}</p>
      </div>
    `;
  }
}

// Extract GraphRAG entities for a document
async function extractGraphRAG(source, isBatchMode = false) {
  const fileName = source.split('/').pop();
  const safeId = source.replace(/[^a-zA-Z0-9]/g, '_');

  try {
    // Check if extraction should stop
    if (shouldStopExtraction) {
      // If not in batch mode, reset the flag and continue
      if (!isBatchMode) {
        console.log('[GraphRAG] Resetting stop flag for individual extraction');
        shouldStopExtraction = false;
      } else {
        console.log('[GraphRAG] Extraction stopped by user for:', fileName);
        return; // 静かに終了、エラーをスローしない
      }
    }

    // Set current extracting PDF
    currentExtractingPdf = source;

    // Start extraction mode - show stop button (only for individual mode)
    if (!isBatchMode) {
      isExtracting = true;
      updateExtractionButtons(true);
    }

    // Refresh document list to show current extraction status
    await refreshDocumentList();

    // Get references after DOM refresh
    const progressContainer = document.getElementById(`progress-${safeId}`);
    const extractBtn = document.querySelector(`.btn-extract[data-source="${source}"]`);

    // Use selected chat model or get first available
    let chatModel = selectedChatModel;

    if (!chatModel) {
      const chatModels = await loadChatModels();
      if (chatModels.length === 0) {
        throw new Error('No chat models available. Please install a chat model in Ollama.');
      }
      chatModel = chatModels[0];
      selectedChatModel = chatModel;
    }

    console.log(`[GraphRAG] Starting extraction for: ${fileName} using model: ${chatModel}`);

    // Show progress container
    if (progressContainer) {
      progressContainer.classList.add('active');
    }

    // Disable extract button
    if (extractBtn) {
      extractBtn.disabled = true;
      extractBtn.textContent = '⏳ Extracting...';
    }

    // Progress callback
    const progressCallback = (progress) => {
      // Check stop flag during progress updates
      if (shouldStopExtraction) {
        console.log('[GraphRAG] Progress stopped by user');
        return; // 静かに終了
      }

      // Re-get progress container to ensure we have the latest reference
      const currentProgressContainer = document.getElementById(`progress-${safeId}`);

      if (currentProgressContainer) {
        const progressBar = currentProgressContainer.querySelector('.progress-bar');
        const progressText = currentProgressContainer.querySelector('.progress-text');

        const percentage = Math.round((progress.processed / progress.total) * 100);

        if (progressBar) {
          progressBar.style.width = `${percentage}%`;
          progressBar.textContent = `${percentage}%`;
        }

        if (progressText) {
          progressText.textContent = `Processed: ${progress.processed} / ${progress.total} chunks (${progress.successful} successful, ${progress.skipped} skipped)`;
        }
      }
    };

    // Start extraction
    const result = await window.electronAPI.extractGraphRAGForDocument(
      source,
      chatModel,
      progressCallback
    );

    console.log('[GraphRAG] Extraction complete:', result);

    // Get current extract button reference
    const currentExtractBtn = document.querySelector(`.btn-extract[data-source="${source}"]`);

    // Update UI - ALWAYS update button state when extraction completes
    if (currentExtractBtn) {
      currentExtractBtn.textContent = '✓ GraphRAG Extracted';
      currentExtractBtn.disabled = true;
    }

    // データベースから実際の進捗を確認（デバッグ用）
    const actualProgress = window.electronAPI.getGraphRAGProgress(source);
    console.log('[GraphRAG] Extraction result:', result);
    console.log('[GraphRAG] Actual database progress:', actualProgress);

    // Clear current extracting PDF
    currentExtractingPdf = null;

    // Refresh document list in batch mode to ensure UI consistency
    if (isBatchMode) {
      await refreshDocumentList();
    }

    // End extraction mode - hide stop button (only for individual mode)
    if (!isBatchMode) {
      isExtracting = false;
      shouldStopExtraction = false;
      updateExtractionButtons(false);
    }

    // Only show individual completion message if not in batch mode and not stopped
    if (!isBatchMode && !shouldStopExtraction) {
      // Refresh document list to show updated status (before alert)
      await refreshDocumentList();

      alert(
        `✓ GraphRAG Extraction Complete\n\n` +
        `Document: ${fileName}\n` +
        `Chunks processed: ${result.totalChunks}\n` +
        `Entities found: ${result.entities}\n` +
        `Relationships found: ${result.relationships}\n` +
        `Mentions found: ${result.mentions}`
      );

      // Refresh again to ensure button state is reflected
      await refreshDocumentList();
    }
  } catch (error) {
    console.error('[ERROR] GraphRAG extraction failed:', error);

    // Clear current extracting PDF
    currentExtractingPdf = null;

    // Check if this was a user-initiated stop before resetting flags
    const wasStopped = shouldStopExtraction;

    // Get current references to DOM elements
    const currentExtractBtn = document.querySelector(`.btn-extract[data-source="${source}"]`);
    const currentProgressContainer = document.getElementById(`progress-${safeId}`);

    // Re-enable extract button
    if (currentExtractBtn) {
      currentExtractBtn.disabled = false;
      currentExtractBtn.textContent = '🕸️ Extract GraphRAG';
    }

    // End extraction mode - hide stop button (only for individual mode)
    if (!isBatchMode) {
      isExtracting = false;
      shouldStopExtraction = false;
      updateExtractionButtons(false);
    }

    // Hide progress container
    if (currentProgressContainer) {
      currentProgressContainer.classList.remove('active');
    }

    // Don't show alert if stopped by user
    if (!wasStopped) {
      alert(
        `⚠️ GraphRAG Extraction Failed\n\n` +
        `Error: ${error.message}\n\n` +
        `Please check:\n` +
        `• Ollama is running\n` +
        `• A chat model is available\n` +
        `• The document exists in the database`
      );
    }
  }
}

// Upload documents
async function uploadDocuments(files) {
  const loadingIndicator = document.getElementById('loading-indicator');

  try {
    // Show loading indicator
    loadingIndicator.classList.remove('hidden');

    // Get current embedding model
    const currentEmbedModel = window.electronAPI.getCurrentEmbedderModel();
    console.log('[DEBUG] Current embedding model:', currentEmbedModel);

    // Check if embedding model exists
    const modelCheck = await window.electronAPI.checkEmbedModelExists();
    if (!modelCheck.exists) {
      throw new Error(
        `Embedding model "${currentEmbedModel}" not found in Ollama.\n\n` +
        `Please install it using:\n` +
        `ollama pull ${currentEmbedModel}`
      );
    }

    // Check if it's a recommended embedding model
    if (!isRecommendedEmbeddingModel(currentEmbedModel)) {
      const confirmed = confirm(
        `⚠️ Non-Standard Embedding Model Detected\n\n` +
        `You are using: ${currentEmbedModel}\n\n` +
        `This model is not a standard embedding model. ` +
        `Using a regular LLM may result in lower quality vector representations.\n\n` +
        `Recommended embedding models:\n` +
        `${COMMON_EMBEDDING_MODELS.map(m => `• ${m}`).join('\n')}\n\n` +
        `Do you want to continue with "${currentEmbedModel}" anyway?`
      );

      if (!confirmed) {
        loadingIndicator.classList.add('hidden');
        return;
      }
    }

    // Process each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[DEBUG] Processing file ${i + 1}/${files.length}:`, file.path);

      const chunks = await window.electronAPI.readAndSplit(file.path);
      console.log(`[DEBUG] Generated ${chunks.length} chunks for file:`, file.path);

      await window.electronAPI.saveChunksToFaiss(chunks);
      console.log(`[DEBUG] Saved chunks to FAISS for file:`, file.path);
    }

    // Refresh document list
    await refreshDocumentList();

    // Hide loading indicator
    loadingIndicator.classList.add('hidden');

    alert(`✓ Successfully uploaded ${files.length} document(s)\n\nYou can now extract GraphRAG entities for each document.`);
  } catch (error) {
    console.error('[ERROR] Failed to upload documents:', error);
    loadingIndicator.classList.add('hidden');

    const errorMessage = error.message || 'Unknown error';
    const isOllamaError = errorMessage.includes('Internal Server Error') ||
                          errorMessage.includes('Ollama') ||
                          errorMessage.includes('500');

    if (isOllamaError) {
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
        `• nomic-embed-text\n\n` +
        `Please select a different embedding model and try again.`
      );
    } else {
      alert(
        `⚠️ Failed to Process Document\n\n` +
        `Error: ${errorMessage}\n\n` +
        `Please check the file format and try again.`
      );
    }
  }
}

// Extract all unprocessed documents
async function extractAllUnprocessed() {
  try {
    const sources = await window.electronAPI.getStoredSources();

    // Filter unprocessed documents
    const unprocessedDocs = sources.filter(item => {
      const progress = window.electronAPI.getGraphRAGProgress(item.source);
      return progress.percentage < 100;
    });

    if (unprocessedDocs.length === 0) {
      alert('All documents are already fully extracted!');
      return;
    }

    // Check if chat model is selected
    if (!selectedChatModel) {
      alert('Please select a chat model for GraphRAG extraction first.');
      return;
    }

    const confirmed = confirm(
      `Extract GraphRAG data from ${unprocessedDocs.length} unprocessed document(s)?\n\n` +
      `Chat Model: ${selectedChatModel}\n\n` +
      `This may take some time depending on document size.`
    );

    if (!confirmed) {
      return;
    }

    // Start extraction mode
    isExtracting = true;
    shouldStopExtraction = false;
    updateExtractionButtons(true);

    let processedCount = 0;

    // Process each unprocessed document
    for (let i = 0; i < unprocessedDocs.length; i++) {
      // Check if user requested stop
      if (shouldStopExtraction) {
        console.log('[Batch] Extraction stopped by user');
        break;
      }

      const doc = unprocessedDocs[i];
      console.log(`[Batch] Processing document ${i + 1}/${unprocessedDocs.length}: ${doc.source}`);

      try {
        await extractGraphRAG(doc.source, true); // Pass true for batch mode
        processedCount++;
      } catch (error) {
        console.error(`[Batch] Failed to extract ${doc.source}:`, error);

        // If stopped by user, break without showing error dialog
        if (shouldStopExtraction) {
          break;
        }

        const continueProcessing = confirm(
          `Failed to extract "${doc.source.split('/').pop()}":\n\n` +
          `${error.message}\n\n` +
          `Continue with remaining documents?`
        );

        if (!continueProcessing) {
          break;
        }
      }
    }

    // Check if extraction was stopped before resetting flags
    const wasStopped = shouldStopExtraction;

    // End extraction mode
    isExtracting = false;
    shouldStopExtraction = false;
    updateExtractionButtons(false);

    const message = wasStopped
      ? `Extraction stopped!\n\nProcessed ${processedCount} of ${unprocessedDocs.length} document(s).\n\nYou can resume extraction at any time.`
      : `Batch extraction complete!\n\nProcessed ${processedCount} document(s).`;

    alert(message);
    await refreshDocumentList();
  } catch (error) {
    console.error('[ERROR] Batch extraction failed:', error);

    // End extraction mode
    isExtracting = false;
    shouldStopExtraction = false;
    updateExtractionButtons(false);

    alert(`Batch extraction failed: ${error.message}`);
  }
}

// Stop extraction
async function stopExtraction() {
  if (isExtracting) {
    shouldStopExtraction = true;
    isExtracting = false;
    currentExtractingPdf = null;
    updateExtractionButtons(false);
    console.log('[DEBUG] Stop extraction requested');

    // Refresh document list to reset all individual item states
    await refreshDocumentList();

    // Note: メッセージはextractAllUnprocessed()の最後で一度だけ表示される
  }
}

// Initialize when DOM is loaded
window.addEventListener('DOMContentLoaded', async () => {
  console.log('[DEBUG] Manage RAG window loaded');

  // Load vector store
  try {
    await window.electronAPI.loadVectorStore();
  } catch (error) {
    console.error('[ERROR] Failed to load vector store:', error);
  }

  // Display current embedding model
  const currentEmbedModel = window.electronAPI.getCurrentEmbedderModel();
  document.getElementById('current-embed-model').textContent = currentEmbedModel;

  // Listen for embedding model changes
  window.electronAPI.onEmbedModelChanged((modelName) => {
    console.log('[INFO] Embedding model changed to:', modelName);
    document.getElementById('current-embed-model').textContent = modelName;
  });

  // Load chat models for GraphRAG extraction
  const chatModels = await loadChatModels();
  const graphModelSelect = document.getElementById('graph-model-select');

  if (chatModels.length > 0) {
    graphModelSelect.innerHTML = '';
    chatModels.forEach(model => {
      const option = document.createElement('option');
      option.value = model;
      option.textContent = model;
      graphModelSelect.appendChild(option);
    });

    // Set first model as default
    selectedChatModel = chatModels[0];
    graphModelSelect.value = selectedChatModel;
  } else {
    graphModelSelect.innerHTML = '<option value="">No models available</option>';
  }

  // Chat model selection handler
  graphModelSelect.addEventListener('change', (e) => {
    selectedChatModel = e.target.value;
    console.log('[DEBUG] Selected chat model:', selectedChatModel);
  });

  // Refresh document list
  await refreshDocumentList();

  // Upload button click handler - use Electron's native file dialog
  document.getElementById('upload-btn').addEventListener('click', async () => {
    try {
      const filePaths = await window.electronAPI.openFileDialog();
      if (!filePaths || filePaths.length === 0) {
        console.log('[DEBUG] No files selected');
        return;
      }

      console.log('[DEBUG] Selected files:', filePaths);

      // Convert file paths to File-like objects with path property
      const filesWithPaths = filePaths.map(filePath => ({
        path: filePath,
        name: filePath.split('/').pop()
      }));

      await uploadDocuments(filesWithPaths);
    } catch (error) {
      console.error('[ERROR] Failed to open file dialog:', error);
      alert(`Failed to open file dialog: ${error.message}`);
    }
  });

  // Extract all button click handler
  document.getElementById('extract-all-btn').addEventListener('click', async () => {
    await extractAllUnprocessed();
  });

  // Stop extraction button click handler
  document.getElementById('stop-extract-btn').addEventListener('click', () => {
    stopExtraction();
  });

  // ウィンドウを閉じる際にエンティティ抽出を停止
  window.addEventListener('beforeunload', () => {
    if (isExtracting) {
      console.log('[DEBUG] Window closing during extraction, stopping extraction...');
      shouldStopExtraction = true;
      isExtracting = false;
      // Note: beforeunloadではasync処理やalertは制限されているため、
      // フラグのみを設定して、進行中の処理が自然に停止するようにする
    }
  });
});
