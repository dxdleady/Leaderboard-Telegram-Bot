// services/websocketManager.js
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.messageQueues = new Map();
    this.processing = new Map();
    this.timeouts = new Map();
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

    // Clear any existing timeouts for this user
    if (this.timeouts.has(userId)) {
      clearTimeout(this.timeouts.get(userId));
      this.timeouts.delete(userId);
    }

    ws.send(JSON.stringify({ type: 'connection', status: 'connected' }));
  }

  removeConnection(userId) {
    if (this.connections.has(userId)) {
      const ws = this.connections.get(userId);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      this.connections.delete(userId);
    }

    // Clear all state for this user
    this.messageQueues.delete(userId);
    this.processing.delete(userId);
    if (this.timeouts.has(userId)) {
      clearTimeout(this.timeouts.get(userId));
      this.timeouts.delete(userId);
    }
  }

  initializeQueue(userId) {
    if (!this.messageQueues.has(userId)) {
      this.messageQueues.set(userId, Promise.resolve());
      this.processing.set(userId, false);
    }
  }

  async processNextMessage(userId) {
    if (this.processing.get(userId)) return;

    const queue = this.messageQueues.get(userId);
    if (!queue) return;

    this.processing.set(userId, true);

    try {
      await queue;
    } catch (error) {
      console.error(`Error processing message for user ${userId}:`, error);
    } finally {
      this.processing.set(userId, false);

      // Schedule next message processing
      this.timeouts.set(
        userId,
        setTimeout(() => {
          if (this.messageQueues.has(userId)) {
            this.processNextMessage(userId);
          }
        }, 500)
      );
    }
  }

  async queueMessage(userId, action) {
    this.initializeQueue(userId);

    const newPromise = this.messageQueues.get(userId).then(async () => {
      try {
        await action();
      } catch (error) {
        console.error(`Error in queued message for user ${userId}:`, error);
        throw error;
      }
    });

    this.messageQueues.set(userId, newPromise);
    this.processNextMessage(userId);

    return newPromise;
  }

  clearQueue(userId) {
    this.messageQueues.set(userId, Promise.resolve());
    this.processing.set(userId, false);
    if (this.timeouts.has(userId)) {
      clearTimeout(this.timeouts.get(userId));
      this.timeouts.delete(userId);
    }
  }

  isConnected(userId) {
    return (
      this.connections.has(userId) &&
      this.connections.get(userId).readyState === WebSocket.OPEN
    );
  }

  sendToUser(userId, message) {
    if (this.isConnected(userId)) {
      try {
        this.connections.get(userId).send(JSON.stringify(message));
      } catch (error) {
        console.error(`Error sending message to user ${userId}:`, error);
      }
    }
  }

  getActiveConnections() {
    return Array.from(this.connections.keys());
  }
}

const wsManager = new WebSocketManager();
module.exports = wsManager;
