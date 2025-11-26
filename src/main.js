const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');

let mainWindow;
let manageRAGWindow = null;

// グローバルにmainWindowを設定（server.jsからアクセスできるように）
global.mainWindow = null;

// ✨ サーバー起動をここで呼び出す
let server = null;
try {
  server = require('./server');
} catch (err) {
  // Server loading failed
}

function createMainWindow() {
  // ベクターDBのパスを環境に応じて設定
  const vectorDbPath = app.isPackaged
    ? path.join(process.resourcesPath, 'vector-db')
    : path.join(app.getAppPath(), 'vector-db');

  process.env.VECTOR_DB_PATH = vectorDbPath;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
  });

  // グローバルに設定
  global.mainWindow = mainWindow;

  // パッケージ化されている場合とそうでない場合でパスを切り替え
  const indexPath = app.isPackaged
    ? path.join(__dirname, '../build/index.html')
    : path.join(__dirname, '../build/index.html');

  mainWindow.loadFile(indexPath);

  // クリック時にウィンドウを前面に表示
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.moveTop();
    }
  });

  // DevToolsは自動では開かない（メニューやショートカットから開けるようにする）
  // mainWindow.webContents.openDevTools();
}

function createMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // Macの場合のみアプリケーションメニュー
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),

    // File メニュー
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },

    // Edit メニュー（コピー・ペーストなど）
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Speech',
            submenu: [
              { role: 'startSpeaking' },
              { role: 'stopSpeaking' }
            ]
          }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },

    // View メニュー（DevTools含む）
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Developer Tools',
          accelerator: isMac ? 'Cmd+Shift+I' : 'Ctrl+Shift+I',
          click: (item, focusedWindow) => {
            if (focusedWindow) {
              focusedWindow.webContents.toggleDevTools();
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Window メニュー
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' }
        ] : [
          { role: 'close' }
        ])
      ]
    },

    // Help メニュー
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            const { shell } = require('electron');
            await shell.openExternal('https://github.com/NbtKmy/ollama-spielwiese');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}


app.whenReady().then(() => {
    createMenu();
    createMainWindow();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documents', extensions: ['txt', 'pdf', 'md'] }]
    });

    return result.filePaths;
  });

// サーバーポートを取得
ipcMain.handle('get-server-port', () => {
  if (!server || typeof server.getPort !== 'function') {
    return null;
  }
  return server.getPort();
});

// RAG管理ウィンドウを開く
ipcMain.handle('open-manage-rag-window', () => {
  if (manageRAGWindow) {
    manageRAGWindow.focus();
    return;
  }

  manageRAGWindow = new BrowserWindow({
    width: 800,
    height: 700,
    minWidth: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    parent: mainWindow,
    title: 'Manage RAG Documents'
  });

  const managePath = app.isPackaged
    ? path.join(__dirname, '../build/manage-rag.html')
    : path.join(__dirname, '../build/manage-rag.html');

  manageRAGWindow.loadFile(managePath);

  // ウィンドウがロードされた後、メインウィンドウに現在の埋め込みモデルを要求
  manageRAGWindow.webContents.on('did-finish-load', () => {
    // メインウィンドウに現在のモデルをブロードキャストするよう要求
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('request-current-embed-model');
    }
  });

  // クリック時にウィンドウを前面に表示
  manageRAGWindow.on('focus', () => {
    if (manageRAGWindow && !manageRAGWindow.isDestroyed()) {
      manageRAGWindow.moveTop();
    }
  });

  manageRAGWindow.on('closed', () => {
    manageRAGWindow = null;
  });
});

// エンべディングモデル変更通知をすべてのウィンドウにブロードキャスト
ipcMain.on('embed-model-changed', (event, modelName) => {
  // メインウィンドウに通知
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('embed-model-changed', modelName);
  }
  // manage-ragウィンドウに通知
  if (manageRAGWindow && !manageRAGWindow.isDestroyed()) {
    manageRAGWindow.webContents.send('embed-model-changed', modelName);
  }
});