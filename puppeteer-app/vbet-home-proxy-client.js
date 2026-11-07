/**
 * VBet Residential Proxy - Home Client Script
 * 
 * Runs on your home PC to tunnel web traffic from your VPS bot through your home residential IP.
 * Zero external npm dependencies. Standard Node.js only.
 * 
 * Usage:
 *   node vbet-home-proxy-client.js --vps <VPS_IP> --port <TUNNEL_PORT> --token <TOKEN>
 */

const net = require('net');

// Parse CLI Arguments
const args = {};
process.argv.slice(2).forEach(arg => {
    if (arg.startsWith('--')) {
        const parts = arg.substring(2).split('=');
        const key = parts[0];
        const val = parts[1] || true;
        args[key] = val;
    }
});

const vpsHost = args.vps || args.host || '127.0.0.1';
const tunnelPort = parseInt(args.port || args.tunnelPort) || 3080;
const authToken = args.token || '';

if (!authToken) {
    console.error('❌ Error: Security token (--token) is required.');
    process.exit(1);
}

console.log('\n==================================================');
console.log('🌐 VBET RESIDENTIAL PROXY - HOME CLIENT');
console.log('==================================================');
console.log(`VPS Server:   ${vpsHost}`);
console.log(`Tunnel Port:  ${tunnelPort}`);
console.log(`Auth Token:   ${authToken.substring(0, 4)}...${authToken.substring(authToken.length - 4)}`);
console.log('==================================================\n');

let controlSocket = null;
let reconnectTimer = null;
let isReconnecting = false;

function connectToVPS() {
    isReconnecting = false;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    console.log(`[Client] Connecting to VPS at ${vpsHost}:${tunnelPort}...`);

    controlSocket = net.connect({ host: vpsHost, port: tunnelPort }, () => {
        console.log('✅ Connected to VPS Tunnel Server. Sending Authentication...');
        controlSocket.write(`AUTH_CONTROL ${authToken}\n`);
    });

    let buffer = '';
    controlSocket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        while (true) {
            const lineEnd = buffer.indexOf('\n');
            if (lineEnd === -1) break;

            const line = buffer.substring(0, lineEnd).trim();
            buffer = buffer.substring(lineEnd + 1);

            if (line.startsWith('CONNECT ')) {
                const parts = line.split(' ');
                const connectionId = parts[1];
                const targetHost = parts[2];
                const targetPort = parseInt(parts[3]);

                if (connectionId && targetHost && targetPort) {
                    handleConnectCommand(connectionId, targetHost, targetPort);
                }
            } else if (line === 'CONNECTED') {
                console.log('🟢 Authentication successful! Reverse tunnel is active and ready.');
            } else if (line.startsWith('ERROR:')) {
                console.error('[VPS Error]', line);
                controlSocket.end();
            }
        }
    });

    controlSocket.on('error', (err) => {
        console.error('[Tunnel Connection Error]:', err.message || err);
    });

    controlSocket.on('close', () => {
        console.warn('⚠️ Connection closed. Attempting reconnect in 5 seconds...');
        scheduleReconnect();
    });
}

function handleConnectCommand(connectionId, targetHost, targetPort) {
    console.log(`[Tunnel] Routing request for ${targetHost}:${targetPort} (ID: ${connectionId})`);

    // 1. Connect to VPS Tunnel on data channel
    const vpsDataSocket = net.connect({ host: vpsHost, port: tunnelPort }, () => {
        // Authenticate as a data socket
        vpsDataSocket.write(`AUTH_DATA ${authToken} ${connectionId}\n`);

        // 2. Connect to the target website from home residential connection
        const destinationSocket = net.connect({ host: targetHost, port: targetPort }, () => {
            console.log(`[Tunnel] Established connection to ${targetHost}:${targetPort}`);

            // Pipe VPS data socket and local home connection together
            vpsDataSocket.pipe(destinationSocket);
            destinationSocket.pipe(vpsDataSocket);
        });

        destinationSocket.on('error', (err) => {
            console.warn(`[Local Connection Error] Failed to connect to ${targetHost}:${targetPort}:`, err.message);
            vpsDataSocket.end();
        });

        vpsDataSocket.on('error', (err) => {
            destinationSocket.end();
        });
    });

    vpsDataSocket.on('error', (err) => {
        console.warn(`[Tunnel Connection Error] Failed to connect data socket to VPS for ID: ${connectionId}:`, err.message);
    });
}

function scheduleReconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    reconnectTimer = setTimeout(() => {
        connectToVPS();
    }, 5000);
}

// Ensure only a single client instance runs for this tunnel port on this machine
const lockPort = 10000 + tunnelPort;
const lockServer = net.createServer();

lockServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ ERROR: Another instance of this client script is already running on this machine (for VPS port ${tunnelPort}).`);
        console.error(`Please close the other terminal running the home client before launching a new one.\n`);
        process.exit(1);
    } else {
        console.warn(`[Warning] Single-instance lock failed to start:`, err.message);
        // Fall back to connecting anyway if it's some other socket issue
        connectToVPS();
    }
});

lockServer.listen(lockPort, '127.0.0.1', () => {
    // Lock acquired, now proceed to connect
    connectToVPS();
});

