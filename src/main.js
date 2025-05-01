const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

let mainWindow;

// ✨ サーバー起動をここで呼び出す
require('./server'); 

function createMainWindow() {
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

  mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
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