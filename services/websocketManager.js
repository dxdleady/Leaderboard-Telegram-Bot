// services/websocketManager.js
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
  }

  addConnection(userId, ws) {
    this.connections.set(userId, ws);

    ws.on('close', () => this.removeConnection(userId));
    ws.on('error', () => this.removeConnection(userId));

    // Send initial connection status
    this.sendToUser(userId, {
      type: 'connection',
      status: 'connected',
      timestamp: Date.now(),
    });
  }

  removeConnection(userId) {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    this.connections.delete(userId);
  }

  isConnected(userId) {
    return (
      this.connections.has(userId) &&
      this.connections.get(userId).readyState === WebSocket.OPEN
    );
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
