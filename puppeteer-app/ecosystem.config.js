const path = require('path');
const APP_DIR = __dirname;

module.exports = {
  apps: [
    {
      name: "vfl-scraper",
      cwd: APP_DIR,
      script: "utils/ml_runner.js",
      interpreter: "/usr/local/bin/vpn-football-node",
      node_args: "--max-old-space-size=512",
      args: `scrape-live-season ${path.join(APP_DIR, 'databases/sportybet_archive.db')} true sportybet 41104 true --user-data-dir=TEMP --device=desktop --browser=chrome`,
      max_memory_restart: "650M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      min_uptime: "10s",
      autorestart: true,
      error_file: path.join(APP_DIR, "logs/pm2-error.log"),
      out_file: path.join(APP_DIR, "logs/pm2-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        ELECTRON_DISABLE_SANDBOX: "1",
        DISPLAY: process.env.DISPLAY || ""
      }
    },
    {
      name: "bot-dashboard",
      cwd: APP_DIR,
      script: path.join(APP_DIR, "run-web-dashboard.sh"),
      interpreter: "/usr/local/bin/vpn-football-bash",
      max_memory_restart: "600M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      max_restarts: 30,
      min_uptime: "20s",
      autorestart: true,
      error_file: path.join(APP_DIR, "logs/pm2-dashboard-error.log"),
      out_file: path.join(APP_DIR, "logs/pm2-dashboard-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        ELECTRON_DISABLE_SANDBOX: "1"
      }
    },
    {
      name: "ai-trainer",
      cwd: APP_DIR,
      script: "utils/auto_trainer_daemon.js",
      interpreter: "/usr/local/bin/vpn-football-node",
      node_args: "--max-old-space-size=384",
      args: path.join(APP_DIR, "databases/sportybet_archive.db"),
      max_memory_restart: "450M",
      restart_delay: 10000,
      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      min_uptime: "10s",
      autorestart: false,
      error_file: path.join(APP_DIR, "logs/pm2-trainer-error.log"),
      out_file: path.join(APP_DIR, "logs/pm2-trainer-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "google-sync",
      cwd: APP_DIR,
      script: "utils/google_sync_daemon.js",
      interpreter: "/usr/local/bin/vpn-football-node",
      args: "--daemon",
      node_args: "--max-old-space-size=192",
      max_memory_restart: "250M",
      restart_delay: 10000,
      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      min_uptime: "10s",
      autorestart: false,
      error_file: path.join(APP_DIR, "logs/pm2-sync-error.log"),
      out_file: path.join(APP_DIR, "logs/pm2-sync-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production"
      }
    },
    {
      name: "sporty-api",
      cwd: APP_DIR,
      script: "utils/remote_api_server.js",
      interpreter: "/usr/local/bin/vpn-football-node",
      node_args: "--max-old-space-size=256",
      max_memory_restart: "300M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      max_restarts: 50,
      min_uptime: "10s",
      autorestart: true,
      error_file: path.join(APP_DIR, "logs/pm2-api-error.log"),
      out_file: path.join(APP_DIR, "logs/pm2-api-out.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        API_PORT: "4000",
        API_KEY: "vfl_live_key_2026"
      }
    }
  ]
};
