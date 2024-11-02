// services/websocketManager.js
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.messageQueues = new Map();
  }

  addConnection(userId, ws) {
    this.connections.set(userId, ws);
    this.messageQueues.set(userId, []);

    ws.on('close', () => this.removeConnection(userId));
    ws.on('error', () => this.removeConnection(userId));

    ws.send(JSON.stringify({ type: 'connection', status: 'connected' }));
    this.processQueue(userId);
  }

  removeConnection(userId) {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    this.connections.delete(userId);
    this.messageQueues.delete(userId);
  }

  async queueMessage(userId, action) {
    const queue = this.messageQueues.get(userId) || [];
    const promise = (async () => {
      try {
        await action();
      } catch (error) {
        console.error(`Error in queued message for user ${userId}:`, error);
      }
    })();

    queue.push(promise);
    this.messageQueues.set(userId, queue);

    if (queue.length === 1) {
      this.processQueue(userId);
    }
  }

  async processQueue(userId) {
    const queue = this.messageQueues.get(userId);
    if (!queue || queue.length === 0) return;

    try {
      await queue[0];
      await new Promise(resolve => setTimeout(resolve, 1000)); // Ensure delay between messages

      queue.shift();
      this.messageQueues.set(userId, queue);

      if (queue.length > 0) {
        this.processQueue(userId);
      }
    } catch (error) {
      console.error(`Error processing queue for user ${userId}:`, error);
      // Clear queue on error
      this.messageQueues.set(userId, []);
    }
  }

  clearQueue(userId) {
    this.messageQueues.set(userId, []);
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
      ws.send(JSON.stringify(message));
    }
  }

  getActiveConnections() {
    return Array.from(this.connections.keys());
  }
}

const wsManager = new WebSocketManager();
module.exports = wsManager;
