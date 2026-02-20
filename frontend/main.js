const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

let mainWindow;
let backendProcess;

function startBackend() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const serverPath = path.join(__dirname, '..', 'backend', `server${ext}`);
  backendProcess = spawn(serverPath, [], { stdio: 'pipe' });

  backendProcess.stdout.on('data', (data) => {
    console.log(`[backend] ${data}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`[backend] ${data}`);
  });

  backendProcess.on('error', (err) => {
    console.error('Failed to start backend:', err.message);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16213e',
      symbolColor: '#7a8bbf',
      height: 32,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile('index.html');

  // Allow drag-drop into the window
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  startBackend();
  // Give backend a moment to start
  setTimeout(createWindow, 1000);
});

app.on('window-all-closed', () => {
  if (backendProcess) {
    backendProcess.kill();
  }
  app.quit();
});
