const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');

// --- 1. Startup: App.jsx Search & Replace ---
try {
    const file = path.join(__dirname, '../dashboard/src/renderer/src/App.jsx');
    if (fs.existsSync(file)) {
        let code = fs.readFileSync(file, 'utf8');

        const originalCode = code;
        // Replace IP Updater URL spans
        code = code.replaceAll(
            "http://{window.location.hostname || 'YOUR_VPS_IP'}:{config.proxy?.residential?.ipUpdaterPort || 3081}/update-ip",
            "http://{residentialStatus.vpsPublicIp || window.location.hostname || 'YOUR_VPS_IP'}:{config.proxy?.residential?.ipUpdaterPort || 3081}/update-ip"
        );

        // Replace IP Updater URL variables
        code = code.replaceAll(
            "http://${window.location.hostname || 'YOUR_VPS_IP'}:${config.proxy?.residential?.ipUpdaterPort || 3081}/update-ip",
            "http://${residentialStatus.vpsPublicIp || window.location.hostname || 'YOUR_VPS_IP'}:${config.proxy?.residential?.ipUpdaterPort || 3081}/update-ip"
        );

        if (code !== originalCode) {
            fs.writeFileSync(file, code);
            console.log('App.jsx updated with dynamic IP updater changes');
        }
    }
} catch (e) {
    console.error('Error updating App.jsx:', e.message);
}

// --- 2. Reverse Tunnel Proxy Server ---
let tunnelServer = null;
let proxyServer = null;
let controlSocket = null;
let activeAuthToken = '';
let currentTunnelPort = 3080;

let connectedIp = 'Not Connected';
let connectedAt = null;
let vpsPublicIp = '';
let activeConnectionsCount = 0;

const pendingConnections = new Map();
let connectionIdCounter = 0;

function fetchPublicIp() {
    https.get('https://api.ipify.org?format=json', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            try {
                vpsPublicIp = JSON.parse(data).ip;
                console.log(`[Residential] Detected VPS Public IP: ${vpsPublicIp}`);
            } catch (e) { }
        });
    }).on('error', () => { });
}

function establishTunnel(host, port, callback) {
    if (!controlSocket || controlSocket.destroyed) {
        return callback(new Error('Tunnel client not connected'));
    }

    const connectionId = `conn_${++connectionIdCounter}_${Date.now()}`;

    // Connection timeout (15 seconds)
    const timeout = setTimeout(() => {
        pendingConnections.delete(connectionId);
        callback(new Error('Tunnel connection timeout'));
    }, 15000);

    pendingConnections.set(connectionId, {
        callback,
        timeout
    });

    try {
        controlSocket.write(`CONNECT ${connectionId} ${host} ${port}\n`);
    } catch (err) {
        clearTimeout(timeout);
        pendingConnections.delete(connectionId);
        callback(err);
    }
}

function start(tunnelPort, proxyPort, authToken) {
    stop();

    activeAuthToken = authToken;
    currentTunnelPort = tunnelPort;
    fetchPublicIp();

    console.log(`[Residential] Starting Tunnel Server on port ${tunnelPort} and Proxy Server on port ${proxyPort}...`);

    // --- Tunnel TCP Server (handles Client connection) ---
    tunnelServer = net.createServer((socket) => {
        let authenticated = false;
        let buffer = '';

        socket.on('data', (chunk) => {
            if (authenticated) return;

            buffer += chunk.toString('utf8');
            const lineEnd = buffer.indexOf('\n');
            if (lineEnd === -1) return;

            const line = buffer.substring(0, lineEnd).trim();
            const remainder = buffer.substring(lineEnd + 1);

            const parts = line.split(' ');
            const cmd = parts[0];
            const token = parts[1];

            if (token !== activeAuthToken) {
                socket.write('ERROR: Invalid Token\n');
                socket.end();
                return;
            }

            if (cmd === 'AUTH_CONTROL') {
                authenticated = true;
                if (controlSocket) {
                    controlSocket.destroy();
                }
                controlSocket = socket;
                connectedAt = Date.now();
                connectedIp = socket.remoteAddress?.replace(/^.*:/, '') || 'Unknown';

                console.log(`[Residential] Control client connected from ${connectedIp}`);
                socket.write('CONNECTED\n');

                socket.on('close', () => {
                    if (controlSocket === socket) {
                        controlSocket = null;
                        connectedIp = 'Not Connected';
                        connectedAt = null;
                        console.log('[Residential] Control client disconnected');
                    }
                });
                socket.on('error', (err) => {
                    console.error('[Residential] Control socket error:', err.message);
                });

            } else if (cmd === 'AUTH_DATA') {
                const connId = parts[2];
                const pending = pendingConnections.get(connId);
                if (pending) {
                    authenticated = true;
                    clearTimeout(pending.timeout);
                    pendingConnections.delete(connId);

                    pending.callback(null, socket);

                    if (remainder.length > 0) {
                        socket.unshift(Buffer.from(remainder, 'utf8'));
                    }
                } else {
                    socket.end();
                }
            } else {
                socket.end();
            }
        });

        socket.on('error', (err) => {
            // Prevent crashes from uncaught socket errors
        });
    });

    tunnelServer.on('error', (err) => {
        console.error('[Residential] Tunnel Server error:', err.message);
    });

    tunnelServer.listen(tunnelPort, '0.0.0.0', () => {
        console.log(`[Residential] Tunnel Server listening on port ${tunnelPort}`);
    });

    // --- Local HTTP Proxy Server (intercepts browser requests) ---
    proxyServer = net.createServer((clientSocket) => {
        clientSocket.once('data', (chunk) => {
            const requestStr = chunk.toString('utf8');
            const firstLine = requestStr.split('\r\n')[0];
            const parts = firstLine.split(' ');
            if (parts.length < 2) {
                clientSocket.end();
                return;
            }
            const method = parts[0];
            const url = parts[1];

            let host, port;
            const isConnect = method === 'CONNECT';

            if (isConnect) {
                const hostPort = url.split(':');
                host = hostPort[0];
                port = parseInt(hostPort[1]) || 443;
            } else {
                const hostMatch = requestStr.match(/Host:\s*([^\r\n]+)/i);
                if (hostMatch) {
                    const hostPort = hostMatch[1].trim().split(':');
                    host = hostPort[0];
                    port = parseInt(hostPort[1]) || 80;
                } else {
                    try {
                        const parsed = new URL(url);
                        host = parsed.hostname;
                        port = parseInt(parsed.port) || 80;
                    } catch (e) { }
                }
            }

            if (!host || !port) {
                clientSocket.end();
                return;
            }

            establishTunnel(host, port, (err, dataSocket) => {
                if (err) {
                    if (isConnect) {
                        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                    }
                    clientSocket.end();
                    return;
                }

                // Increment active connection count
                activeConnectionsCount++;
                let closed = false;
                const cleanup = () => {
                    if (!closed) {
                        closed = true;
                        activeConnectionsCount = Math.max(0, activeConnectionsCount - 1);
                        clientSocket.destroy();
                        dataSocket.destroy();
                    }
                };

                clientSocket.on('close', cleanup);
                dataSocket.on('close', cleanup);
                clientSocket.on('error', cleanup);
                dataSocket.on('error', cleanup);

                if (isConnect) {
                    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    clientSocket.pipe(dataSocket);
                    dataSocket.pipe(clientSocket);
                } else {
                    dataSocket.write(chunk);
                    clientSocket.pipe(dataSocket);
                    dataSocket.pipe(clientSocket);
                }
            });
        });

        clientSocket.on('error', (err) => {
            // Prevent crashes from uncaught client socket errors
        });
    });

    proxyServer.on('error', (err) => {
        console.error('[Residential] Proxy Server error:', err.message);
    });

    proxyServer.listen(proxyPort, '127.0.0.1', () => {
        console.log(`[Residential] Proxy Server listening on port ${proxyPort}`);
    });
}

function stop() {
    if (tunnelServer) {
        try { tunnelServer.close(); } catch (e) { }
        tunnelServer = null;
    }
    if (proxyServer) {
        try { proxyServer.close(); } catch (e) { }
        proxyServer = null;
    }
    if (controlSocket) {
        try { controlSocket.destroy(); } catch (e) { }
        controlSocket = null;
    }
    for (const [id, pending] of pendingConnections) {
        clearTimeout(pending.timeout);
        pending.callback(new Error('Tunnel server stopped'));
    }
    pendingConnections.clear();
    activeConnectionsCount = 0;
    connectedIp = 'Not Connected';
    connectedAt = null;
}

function getStatus() {
    return {
        connected: !!controlSocket && !controlSocket.destroyed,
        connectedIp: connectedIp,
        connectedAt: connectedAt,
        activeConnections: activeConnectionsCount,
        tunnelPort: currentTunnelPort,
        vpsPublicIp: vpsPublicIp
    };
}

module.exports = {
    start,
    stop,
    getStatus
};
