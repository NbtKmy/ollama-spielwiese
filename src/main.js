const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

let mainWindow;

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

  // 開発時やデバッグ時にDevToolsを開く
  // mainWindow.webContents.openDevTools();
}


app.whenReady().then(() => {
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