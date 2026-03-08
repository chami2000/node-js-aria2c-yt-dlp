const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const si = require('systeminformation');

// Safely import modules
const YTDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
const Aria2 = require('aria2').default || require('aria2');
const ffmpegPath = require('ffmpeg-static'); 

// --- SECURITY & CONFIGURATION ---
// Change this to any secret path/UUID you want!
const WEBUI_PATH = '9afd1229-b893-40c1-84dd-51e7ce204913';

const BIN_DIR = path.join(__dirname, 'bin');
const DOWNLOAD_DIR = path.join(__dirname, 'downlod');

if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Global paths for binaries
const ytDlpPath = path.join(BIN_DIR, 'yt-dlp');
let aria2Cmd = 'aria2c'; 

// --- AUTO-PROVISIONING BOOTLOADER ---
async function setupBinaries() {
    console.log("⚙️  Checking required binaries...");

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
        console.log("✅ ffmpeg found (provided by ffmpeg-static).");
    } else {
        console.error("❌ ffmpeg missing. Please run 'npm install' again.");
    }

    if (!fs.existsSync(ytDlpPath)) {
        console.log("⬇️  yt-dlp not found. Downloading latest version from GitHub...");
        await YTDlpWrap.downloadFromGithub(ytDlpPath);
        if (os.platform() !== 'win32') execSync(`chmod +x "${ytDlpPath}"`);
        console.log("✅ yt-dlp downloaded.");
    } else {
        console.log("✅ yt-dlp found.");
    }

    try {
        execSync('aria2c --version', { stdio: 'ignore' });
        console.log("✅ aria2c found in system.");
    } catch (e) {
        if (os.platform() === 'linux') {
            const localAria2 = path.join(BIN_DIR, 'aria2c');
            if (fs.existsSync(localAria2)) {
                aria2Cmd = localAria2;
                console.log("✅ aria2c found locally.");
            } else {
                console.log("⬇️  aria2c not found. Downloading static Linux build...");
                try {
                    execSync(`wget -qO /tmp/aria2.tar.gz "https://github.com/P3TERX/Aria2-Pro-Core/releases/download/1.37.0/aria2-1.37.0-static-linux-amd64.tar.gz"`);
                    execSync(`tar -xzf /tmp/aria2.tar.gz -C "${BIN_DIR}" aria2c`);
                    execSync(`rm /tmp/aria2.tar.gz`);
                    execSync(`chmod +x "${localAria2}"`);
                    aria2Cmd = localAria2;
                    console.log("✅ aria2c downloaded successfully.");
                } catch (err) {
                    console.log("⚠️ Failed to download static aria2c. Attempting apt-get install...");
                    try {
                        execSync(`sudo apt-get update && sudo apt-get install aria2 -y`, { stdio: 'ignore' });
                        console.log("✅ aria2c installed via apt-get.");
                    } catch (err2) {
                        console.error("❌ Could not resolve aria2c.");
                    }
                }
            }
        } else {
            console.log("⚠️ Please install aria2 manually for your OS.");
        }
    }

    startServer();
}

// --- MAIN SERVER LOGIC ---
function startServer() {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);

    app.use(express.json());
    
    // Hide the file directory behind the secret path too
    app.use(`/${WEBUI_PATH}/files`, express.static(DOWNLOAD_DIR));

    // Block the root domain so scanners see nothing
    app.get('/', (req, res) => res.status(404).send('404 Not Found'));

    const ytDlpWrap = new YTDlpWrap(ytDlpPath);

    const aria2Daemon = spawn(aria2Cmd,[
        '--enable-rpc', 
        '--rpc-listen-all=false', 
        '--rpc-listen-port=6800',
        '--max-concurrent-downloads=10'
    ]);

    aria2Daemon.on('error', (err) => console.error(`❌ aria2c daemon failed:`, err.message));

    const aria2Client = new Aria2({
        host: 'localhost', port: 6800, secure: false, secret: '', path: '/jsonrpc'
    });

    setTimeout(() => {
        aria2Client.open()
            .then(() => console.log('🚀 Web UI is LIVE! Connected to Aria2 RPC'))
            .catch(() => console.error('⚠️ Aria2 RPC failed to connect.'));
    }, 1000);

    let queue =[];
    let activeDownloads = 0;
    let maxSimultaneousDownloads = 2;

    setInterval(async () => {
        try {
            const cpu = await si.currentLoad();
            const mem = await si.mem();
            const fsSize = await si.fsSize();
            const mainDisk = fsSize.length > 0 ? fsSize[0] : { available: 0 };
            
            io.emit('stats', {
                cpu: Math.round(cpu.currentLoad),
                ram: Math.round((mem.active / mem.total) * 100),
                totalRam: (mem.total / (1024 ** 3)).toFixed(2),
                freeRam: (mem.available / (1024 ** 3)).toFixed(2),
                freeDiskSpace: (mainDisk.available / (1024 ** 3)).toFixed(2) + ' GB'
            });
        } catch (err) {}
    }, 2000);

    async function processQueue() {
        if (activeDownloads >= maxSimultaneousDownloads) return;

        const job = queue.find(j => j.status === 'pending');
        if (!job) return;

        job.status = 'downloading';
        activeDownloads++;
        io.emit('queue-update', queue);

        try {
            if (job.downloader === 'yt-dlp') {
                const args =[
                    job.url,
                    '--ffmpeg-location', ffmpegPath,
                    '--concurrent-fragments', job.parallel.toString(),
                    '-o', path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s')
                ];

                let ytDlpEvent = ytDlpWrap.exec(args);
                
                ytDlpEvent.on('progress', (progress) => {
                    if(progress.percent) {
                        job.progress = progress.percent.toFixed(1);
                        io.emit('queue-update', queue);
                    }
                });

                ytDlpEvent.on('error', () => finishJob(job, 'failed'));
                ytDlpEvent.on('close', () => finishJob(job, 'completed'));

            } else if (job.downloader === 'aria2c') {
                const guid = await aria2Client.call('addUri', [job.url], {
                    dir: DOWNLOAD_DIR,
                    'max-connection-per-server': job.parallel,
                    'split': job.parallel
                });

                const interval = setInterval(async () => {
                    if(job.status !== 'downloading') return clearInterval(interval);
                    try {
                        const status = await aria2Client.call('tellStatus', guid);
                        if (status.status === 'complete') {
                            clearInterval(interval);
                            finishJob(job, 'completed');
                        } else if (status.status === 'error') {
                            clearInterval(interval);
                            finishJob(job, 'failed');
                        } else if (status.totalLength > 0) {
                            job.progress = ((status.completedLength / status.totalLength) * 100).toFixed(1);
                            io.emit('queue-update', queue);
                        }
                    } catch(e) { 
                        clearInterval(interval); 
                        finishJob(job, 'failed'); 
                    }
                }, 1000);
            }
        } catch (err) {
            finishJob(job, 'failed');
        }
    }

    function finishJob(job, status) {
        if (job.status === status) return; 
        job.status = status;
        job.progress = status === 'completed' ? 100 : job.progress;
        activeDownloads--;
        io.emit('queue-update', queue);
        processQueue();
    }

    // --- SECURE API ROUTES ---
    app.post(`/${WEBUI_PATH}/api/settings`, (req, res) => {
        maxSimultaneousDownloads = req.body.simultaneous || 2;
        processQueue();
        res.send({ success: true });
    });

    app.post(`/${WEBUI_PATH}/api/download`, (req, res) => {
        queue.push({
            id: Date.now().toString(),
            url: req.body.url,
            downloader: req.body.downloader,
            parallel: req.body.parallel || 1,
            status: 'pending',
            progress: 0
        });
        io.emit('queue-update', queue);
        processQueue();
        res.send({ success: true });
    });

    app.delete(`/${WEBUI_PATH}/api/queue/:id`, (req, res) => {
        queue = queue.filter(j => j.id !== req.params.id);
        io.emit('queue-update', queue);
        res.send({ success: true });
    });

    app.get(`/${WEBUI_PATH}/api/files`, (req, res) => {
        fs.readdir(DOWNLOAD_DIR, (err, files) => {
            if (err) return res.status(500).send(err);
            const fileData = files.map(file => {
                const stats = fs.statSync(path.join(DOWNLOAD_DIR, file));
                return {
                    name: file,
                    size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                    isVid: /\.(mp4|webm|mkv)$/i.test(file)
                };
            });
            res.json(fileData);
        });
    });

    app.delete(`/${WEBUI_PATH}/api/files/:name`, (req, res) => {
        fs.unlink(path.join(DOWNLOAD_DIR, path.basename(req.params.name)), err => {
            if (err) return res.status(500).send(err);
            res.send({ success: true });
        });
    });

    process.on('SIGINT', () => {
        aria2Daemon.kill('SIGINT');
        process.exit();
    });

    // --- SECURE WEB UI COMPONENT ---
    app.get(`/${WEBUI_PATH}`, (req, res) => {
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Download Manager Pro</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <script src="/socket.io/socket.io.js"></script>
        </head>
        <body class="bg-light">
            <nav class="navbar navbar-dark bg-dark mb-4 shadow-sm">
                <div class="container-fluid">
                    <span class="navbar-brand mb-0 h1">⚡ Downloader Auto-UI</span>
                    <div class="text-white d-flex gap-4">
                        <span>CPU: <span id="cpu">0</span>%</span>
                        <span>RAM: <span id="ram">0</span>% (<span id="freeRam">0</span> GB Free)</span>
                        <span>Disk: <span id="disk">0</span> Free</span>
                    </div>
                </div>
            </nav>

            <div class="container">
                <div class="row mb-4">
                    <div class="col-md-8">
                        <div class="card shadow-sm border-0">
                            <div class="card-header bg-primary text-white">➕ Add New Download</div>
                            <div class="card-body d-flex gap-2">
                                <input type="text" id="url" class="form-control" placeholder="Enter File/Video URL">
                                <select id="downloader" class="form-select" style="width: auto;">
                                    <option value="yt-dlp">yt-dlp</option>
                                    <option value="aria2c">aria2c</option>
                                </select>
                                <input type="number" id="parallel" class="form-control" title="Parallel Connections" style="width: 100px;" value="4" min="1" max="16">
                                <button onclick="addDownload()" class="btn btn-primary">Download</button>
                            </div>
                        </div>
                    </div>

                    <div class="col-md-4">
                        <div class="card shadow-sm border-0">
                            <div class="card-header bg-secondary text-white">⚙️ Settings</div>
                            <div class="card-body d-flex gap-2 align-items-center">
                                <label>Simultaneous DLs:</label>
                                <input type="number" id="simultaneous" class="form-control" value="2" min="1" onchange="updateSettings()" style="width: 80px;">
                            </div>
                        </div>
                    </div>
                </div>

                <div class="card shadow-sm mb-4 border-0">
                    <div class="card-header bg-dark text-white">🔄 Download Queue</div>
                    <div class="card-body p-0">
                        <table class="table table-hover m-0">
                            <thead class="table-light"><tr><th>URL</th><th>Tool</th><th>Connections</th><th>Status</th><th>Progress</th><th>Action</th></tr></thead>
                            <tbody id="queueTable"></tbody>
                        </table>
                    </div>
                </div>

                <div class="card shadow-sm border-0">
                    <div class="card-header bg-dark text-white d-flex justify-content-between align-items-center">
                        <span>📁 /downlod File Browser</span>
                        <button class="btn btn-sm btn-light" onclick="loadFiles()">Refresh</button>
                    </div>
                    <div class="card-body p-0">
                        <table class="table table-hover m-0">
                            <thead class="table-light"><tr><th>File Name</th><th>Size</th><th>Actions</th></tr></thead>
                            <tbody id="fileTable"></tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div class="modal fade" id="videoModal" tabindex="-1">
                <div class="modal-dialog modal-xl">
                    <div class="modal-content bg-dark">
                        <div class="modal-header border-0">
                            <h5 class="modal-title text-white" id="videoTitle">Video Player</h5>
                            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body text-center pb-4">
                            <video id="videoPlayer" controls style="max-width: 100%; border-radius: 8px;"></video>
                        </div>
                    </div>
                </div>
            </div>

            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
            <script>
                const socket = io();

                socket.on('stats', stats => {
                    document.getElementById('cpu').innerText = stats.cpu;
                    document.getElementById('ram').innerText = stats.ram;
                    document.getElementById('freeRam').innerText = stats.freeRam;
                    document.getElementById('disk').innerText = stats.freeDiskSpace;
                });

                socket.on('queue-update', queue => {
                    const tbody = document.getElementById('queueTable');
                    tbody.innerHTML = '';
                    queue.forEach(job => {
                        const progressColor = job.status === 'completed' ? 'bg-success' : (job.status === 'failed' ? 'bg-danger' : 'bg-primary');
                        tbody.innerHTML += \`
                            <tr>
                                <td class="text-truncate" style="max-width: 300px;" title="\${job.url}">\${job.url}</td>
                                <td><span class="badge bg-secondary">\${job.downloader}</span></td>
                                <td>\${job.parallel}</td>
                                <td>\${job.status.toUpperCase()}</td>
                                <td style="width: 250px;">
                                    <div class="progress" style="height: 20px;">
                                        <div class="progress-bar progress-bar-striped progress-bar-animated \${progressColor}" style="width: \${job.progress}%">\${job.progress}%</div>
                                    </div>
                                </td>
                                <td><button class="btn btn-sm btn-outline-danger" onclick="removeJob('\${job.id}')">Remove</button></td>
                            </tr>
                        \`;
                    });
                    loadFiles(); 
                });

                function addDownload() {
                    const url = document.getElementById('url').value;
                    if(!url) return;
                    fetch('/${WEBUI_PATH}/api/download', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ 
                            url, 
                            downloader: document.getElementById('downloader').value, 
                            parallel: document.getElementById('parallel').value 
                        })
                    }).then(() => document.getElementById('url').value = '');
                }

                function updateSettings() {
                    fetch('/${WEBUI_PATH}/api/settings', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ simultaneous: document.getElementById('simultaneous').value })
                    });
                }

                function removeJob(id) { fetch('/${WEBUI_PATH}/api/queue/' + id, { method: 'DELETE' }); }

                function loadFiles() {
                    fetch('/${WEBUI_PATH}/api/files').then(r => r.json()).then(files => {
                        const tbody = document.getElementById('fileTable');
                        tbody.innerHTML = '';
                        files.forEach(f => {
                            let actions = \`<a href="/${WEBUI_PATH}/files/\${f.name}" download class="btn btn-sm btn-outline-primary">Download</a> \`;
                            if (f.isVid) {
                                actions += \`<button class="btn btn-sm btn-success" onclick="playVideo('\${f.name}')">Play in UI</button> \`;
                            }
                            actions += \`<button class="btn btn-sm btn-danger" onclick="deleteFile('\${f.name}')">Delete</button>\`;

                            tbody.innerHTML += \`
                                <tr>
                                    <td class="align-middle fw-medium">\${f.name}</td>
                                    <td class="align-middle">\${f.size}</td>
                                    <td>\${actions}</td>
                                </tr>
                            \`;
                        });
                    });
                }

                function deleteFile(name) {
                    if(confirm('Delete ' + name + '?')) {
                        fetch('/${WEBUI_PATH}/api/files/' + encodeURIComponent(name), { method: 'DELETE' }).then(() => loadFiles());
                    }
                }

                function playVideo(name) {
                    const player = document.getElementById('videoPlayer');
                    document.getElementById('videoTitle').innerText = name;
                    player.src = '/${WEBUI_PATH}/files/' + encodeURIComponent(name);
                    player.play();
                    new bootstrap.Modal(document.getElementById('videoModal')).show();
                }

                document.getElementById('videoModal').addEventListener('hidden.bs.modal', () => {
                    document.getElementById('videoPlayer').pause();
                });

                loadFiles();
            </script>
        </body>
        </html>
        `);
    });

    const PORT = 3000;
    server.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`🔐 SECRET URL: http://localhost:${PORT}/${WEBUI_PATH}`);
        console.log(`======================================================\n`);
    });
}

// Boot Sequence
setupBinaries();
