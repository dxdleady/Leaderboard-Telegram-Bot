const WebSocket = require('ws');
const { EventEmitter } = require('events');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // userId -> WebSocket
    this.messageQueues = new Map(); // userId -> Promise
    this.processingQueues = new Map(); // userId -> boolean
  }

  addConnection(userId, ws) {
    this.connections.set(userId, ws);
    this.initializeQueue(userId);

    ws.on('close', () => {
      this.removeConnection(userId);
    });

    ws.on('error', error => {
      console.error(`WebSocket error for user ${userId}:`, error);
      this.removeConnection(userId);
    });

    // Send initial connection status
    ws.send(JSON.stringify({ type: 'connection', status: 'connected' }));
  }

  removeConnection(userId) {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    this.connections.delete(userId);
    this.messageQueues.delete(userId);
    this.processingQueues.delete(userId);
    console.log(`WebSocket connection removed for user ${userId}`);
  }

  initializeQueue(userId) {
    if (!this.messageQueues.has(userId)) {
      this.messageQueues.set(userId, Promise.resolve());
      this.processingQueues.set(userId, false);
    }
  }

  async queueMessage(userId, action) {
    this.initializeQueue(userId);

    const queue = this.messageQueues.get(userId);
    const newPromise = queue.then(async () => {
      if (this.processingQueues.get(userId)) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      this.processingQueues.set(userId, true);
      try {
        await action();
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error('Error in queued message:', error);
        throw error;
      } finally {
        this.processingQueues.set(userId, false);
      }
    });

    this.messageQueues.set(userId, newPromise);
    return newPromise;
  }

  clearQueue(userId) {
    this.messageQueues.set(userId, Promise.resolve());
    this.processingQueues.set(userId, false);
  }

  isConnected(userId) {
    return (
      this.connections.has(userId) &&
      this.connections.get(userId).readyState === WebSocket.OPEN
    );
  }

  broadcast(message) {
    for (const [userId, ws] of this.connections.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    }
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
