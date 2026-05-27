const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 1000,
    minWidth: 800,
    minHeight: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#f5ebe0',
    title: 'Coffee Shop Inventory'
  });

  mainWindow.loadFile('index.html');

  if (process.argv.includes('--enable-logging')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Foundry Local SDK ──────────────────────────────────────────────────────────
const MODEL_ALIAS = 'qwen3.5-9b';
const MAX_IMAGE_DIM = 960;

// ── Image resize helper ─────────────────────────────────────────────────────────
function resizeImageBase64(base64, mimeType) {
  const { execSync } = require('child_process');
  const os = require('os');
  const tmpIn = path.join(os.tmpdir(), `fl_in_${Date.now()}.png`);
  const tmpOut = path.join(os.tmpdir(), `fl_out_${Date.now()}.png`);
  const tmpScript = path.join(os.tmpdir(), `fl_resize_${Date.now()}.ps1`);

  try {
    fs.writeFileSync(tmpIn, Buffer.from(base64, 'base64'));
    fs.writeFileSync(tmpScript, [
      'Add-Type -AssemblyName System.Drawing',
      `$img = [System.Drawing.Image]::FromFile("${tmpIn}")`,
      `$max = ${MAX_IMAGE_DIM}`,
      'if ($img.Width -gt $max -or $img.Height -gt $max) {',
      '  $scale = [Math]::Min($max / $img.Width, $max / $img.Height)',
      '  $nw = [int]($img.Width * $scale); $nh = [int]($img.Height * $scale)',
      '  $bmp = New-Object System.Drawing.Bitmap($nw, $nh)',
      '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
      '  $g.InterpolationMode = "HighQualityBicubic"',
      '  $g.DrawImage($img, 0, 0, $nw, $nh)',
      '  $g.Dispose(); $img.Dispose()',
      `  $bmp.Save("${tmpOut}", [System.Drawing.Imaging.ImageFormat]::Png)`,
      '  $bmp.Dispose()',
      '  Write-Host "resized"',
      '} else { $img.Dispose(); Write-Host "ok" }',
    ].join('\n'));
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`, { encoding: 'utf8' }).trim();
    try { fs.unlinkSync(tmpScript); } catch {}
    if (out.startsWith('resized')) {
      const resizedBase64 = fs.readFileSync(tmpOut).toString('base64');
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
      return `data:image/png;base64,${resizedBase64}`;
    }
    try { fs.unlinkSync(tmpIn); } catch {}
  } catch {
    try { fs.unlinkSync(tmpScript); } catch {}
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
  return `data:${mimeType};base64,${base64}`;
}

let manager = null;
let currentModel = null;
let responsesClient = null;
let webServiceStarted = false;
let initPromise = null;

async function initializeSDK() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { FoundryLocalManager } = await import('foundry-local-sdk');

    // In packaged Electron apps, native DLLs are unpacked to app.asar.unpacked
    // but the SDK resolves paths relative to app.asar. Fix by providing explicit path.
    let libraryPath = undefined;
    const asarCorePath = path.join(__dirname, 'node_modules', 'foundry-local-sdk',
      'foundry-local-core', `${process.platform}-${process.arch}`,
      'Microsoft.AI.Foundry.Local.Core.dll');
    if (asarCorePath.includes('app.asar')) {
      libraryPath = asarCorePath.replace('app.asar', 'app.asar.unpacked');
    }

    manager = FoundryLocalManager.create({
      appName: 'qwen_vision_describer',
      logLevel: 'info',
      ...(libraryPath && { libraryPath })
    });

    // Download and register execution providers for hardware acceleration
    let currentEp = '';
    await manager.downloadAndRegisterEps((epName, percent) => {
      if (epName !== currentEp) {
        if (currentEp !== '') process.stdout.write('\n');
        currentEp = epName;
      }
      process.stdout.write(`\r  ${epName.padEnd(30)}  ${percent.toFixed(1).padStart(5)}%`);
    });
    if (currentEp !== '') process.stdout.write('\n');

    return manager;
  })();

  return initPromise;
}

function ensureWebService() {
  if (!webServiceStarted && manager) {
    manager.startWebService();
    webServiceStarted = true;
  }
}

// ── IPC handlers ────────────────────────────────────────────────────────────────

ipcMain.handle('initialize', async () => {
  try {
    await initializeSDK();
    return { success: true };
  } catch (err) {
    console.error('SDK init error:', err);
    throw err;
  }
});

ipcMain.handle('download-model', async () => {
  try {
    await initializeSDK();
    // 1. get the model object
    const model = await manager.catalog.getModel(MODEL_ALIAS);
    if (!model) throw new Error(`Model "${MODEL_ALIAS}" not found in catalog`);

    mainWindow.webContents.send('status', 'Downloading model…');

    // 2. download the model
    await model.download((percent) => {
      mainWindow.webContents.send('download-progress', percent);
    });

    return { success: true };
  } catch (err) {
    console.error('Download error:', err);
    throw err;
  }
});

ipcMain.handle('load-model', async () => {
  try {
    await initializeSDK();
    ensureWebService();

    const model = await manager.catalog.getModel(MODEL_ALIAS);
    if (!model) throw new Error(`Model "${MODEL_ALIAS}" not found`);

    if (!model.isCached) {
      await model.download((percent) => {
        mainWindow.webContents.send('download-progress', percent);
      });
    }

    mainWindow.webContents.send('status', 'Loading model into memory…');
    // 3. load the model into memory
    await model.load();

    // Wait until model is fully loaded
    while (!(await model.isLoaded())) {
      await new Promise(r => setTimeout(r, 100));
    }

    currentModel = model;

    // 4. Create the responses client using the SDK
    ensureWebService();
    responsesClient = manager.createResponsesClient(model.id);
    responsesClient.settings.temperature = 0.7;
    responsesClient.settings.maxOutputTokens = 2048;

    return { success: true, modelId: model.id };
  } catch (err) {
    console.error('Load error:', err);
    throw err;
  }
});

ipcMain.handle('describe-image', async (_event, base64Image, mimeType) => {
  if (!currentModel) throw new Error('Model not loaded');
  if (!responsesClient) throw new Error('Responses client not initialized');

  const dataUrl = resizeImageBase64(base64Image, mimeType);

  const input = [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_image',
          image_url: dataUrl,
          media_type: mimeType,
          detail: 'auto'
        },
        {
          type: 'input_text',
          text: 'You are a helpful coffee shop inventory assistant. Please identify and list all inventory items visible in this image. Include quantities, brands, and conditions where possible. I want a comprehensive list of all the objects in the image.'
        }
      ]
    }
  ];

  const startTime = performance.now();
  let firstTokenTime = null;
  let tokenCount = 0;
  let fullContent = '';

  // 5. get a streaming response from the model
  await responsesClient.createStreaming(input, (event) => {
    if (event.type === 'response.output_text.delta' && event.delta) {
      if (firstTokenTime === null) firstTokenTime = performance.now();
      tokenCount++;
      fullContent += event.delta;

      mainWindow.webContents.send('describe-chunk', {
        content: event.delta,
        tokenCount,
        timeToFirstToken: firstTokenTime ? (firstTokenTime - startTime) : null
      });
    }

    if (event.type === 'response.completed' && event.response?.usage) {
      tokenCount = event.response.usage.output_tokens || tokenCount;
    }
  });

  const totalTime = performance.now() - startTime;

  return {
    content: fullContent,
    stats: {
      tokenCount,
      timeToFirstToken: firstTokenTime ? Math.round(firstTokenTime - startTime) : 0,
      totalTime: Math.round(totalTime),
      tokensPerSecond: tokenCount > 0 ? parseFloat((tokenCount / (totalTime / 1000)).toFixed(2)) : 0
    }
  };
});

ipcMain.handle('select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an Image',
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp'
  };

  const buffer = fs.readFileSync(filePath);
  return {
    base64: buffer.toString('base64'),
    mimeType: mimeMap[ext] || 'image/png',
    fileName: path.basename(filePath)
  };
});
