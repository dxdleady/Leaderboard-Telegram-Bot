// services/websocketManager.js
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.lastPing = new Map();
  }

  addConnection(userId, ws) {
    // Close existing connection if any
    if (this.connections.has(userId)) {
      const existingWs = this.connections.get(userId);
      if (existingWs.readyState === WebSocket.OPEN) {
        existingWs.close();
      }
    }

    this.connections.set(userId, ws);
    this.lastPing.set(userId, Date.now());

    ws.on('close', () => this.removeConnection(userId));
    ws.on('error', () => this.removeConnection(userId));
    ws.on('pong', () => this.lastPing.set(userId, Date.now()));

    this.setupHeartbeat(userId, ws);

    ws.send(
      JSON.stringify({
        type: 'connection',
        status: 'connected',
        timestamp: Date.now(),
      })
    );
  }

  removeConnection(userId) {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    this.connections.delete(userId);
    this.lastPing.delete(userId);
  }

  setupHeartbeat(userId, ws) {
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        const lastPing = this.lastPing.get(userId);
        if (Date.now() - lastPing > 30000) {
          // 30 seconds timeout
          this.removeConnection(userId);
          clearInterval(interval);
        } else {
          ws.ping();
        }
      } else {
        clearInterval(interval);
      }
    }, 15000); // Check every 15 seconds

    ws.on('close', () => clearInterval(interval));
  }

  isConnected(userId) {
    const ws = this.connections.get(userId);
    return ws && ws.readyState === WebSocket.OPEN;
  }

  sendToUser(userId, message) {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            ...message,
            timestamp: Date.now(),
          })
        );
      } catch (error) {
        console.error(
          `Error sending WebSocket message to user ${userId}:`,
          error
        );
      }
    }
  }

  updateQuizProgress(userId, data) {
    this.sendToUser(userId, {
      type: 'quiz_progress',
      ...data,
    });
  }

  getActiveConnections() {
    return Array.from(this.connections.keys());
  }
}

const wsManager = new WebSocketManager();
module.exports = wsManager;
