// services/websocketManager.js
class WebSocketManager {
  constructor() {
    this.connections = new Map();
    this.messageQueues = new Map();
    this.processingQueues = new Map();
    this.reconnectTimeouts = new Map();
    this.pendingPromises = new Map(); // Track pending promises
  }
  // Add this method that was missing
  initializeQueue(userId) {
    if (!this.messageQueues.has(userId)) {
      this.messageQueues.set(userId, []);
      this.processingQueues.set(userId, false);
    }
  }

  addConnection(userId, ws) {
    // Clear any existing reconnect timeout
    if (this.reconnectTimeouts.has(userId)) {
      clearTimeout(this.reconnectTimeouts.get(userId));
      this.reconnectTimeouts.delete(userId);
    }

    // Properly clean up existing connection
    this.removeConnection(userId);

    // Set up the new connection with error handling
    this.connections.set(userId, ws);
    this.initializeQueue(userId);

    // Enhanced error handling
    ws.on('error', error => {
      console.error(`WebSocket error for user ${userId}:`, error);
      this.handleConnectionError(userId);
    });

    ws.on('close', () => {
      console.log(`WebSocket closed for user ${userId}`);
      this.handleConnectionError(userId);
    });

    // Add ping/pong handling
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Process any pending messages
    setImmediate(() => this.processQueue(userId));
  }

  async removeConnection(userId) {
    const ws = this.connections.get(userId);
    if (ws) {
      try {
        // Reject any pending promises
        const pendingPromises = this.pendingPromises.get(userId) || [];
        pendingPromises.forEach(promise => {
          promise.reject(new Error('Connection closed'));
        });
        this.pendingPromises.delete(userId);

        ws.terminate(); // Use terminate instead of close for immediate closure
      } catch (error) {
        console.error(`Error closing WebSocket for user ${userId}:`, error);
      }
    }
    this.connections.delete(userId);
    this.setReconnectTimeout(userId);
  }

  async queueMessage(userId, messageCallback) {
    if (!this.messageQueues.has(userId)) {
      this.initializeQueue(userId);
    }

    const promise = new Promise((resolve, reject) => {
      const pendingPromises = this.pendingPromises.get(userId) || [];
      pendingPromises.push({ resolve, reject });
      this.pendingPromises.set(userId, pendingPromises);

      this.messageQueues.get(userId).push({
        callback: messageCallback,
        timestamp: Date.now(),
        promiseIndex: pendingPromises.length - 1,
      });
    });

    // Start processing if not already processing
    setImmediate(() => {
      if (!this.processingQueues.get(userId)) {
        this.processQueue(userId);
      }
    });

    return promise;
  }

  async processQueue(userId) {
    if (!this.messageQueues.has(userId) || this.processingQueues.get(userId)) {
      return;
    }

    this.processingQueues.set(userId, true);
    const queue = this.messageQueues.get(userId);
    const pendingPromises = this.pendingPromises.get(userId) || [];

    while (queue.length > 0 && this.isConnected(userId)) {
      const message = queue[0];
      const promise = pendingPromises[message.promiseIndex];

      try {
        // Check message timeout
        if (Date.now() - message.timestamp > 5 * 60 * 1000) {
          queue.shift();
          if (promise) {
            promise.reject(new Error('Message timeout'));
          }
          continue;
        }

        await message.callback();
        queue.shift();
        if (promise) {
          promise.resolve();
        }
      } catch (error) {
        console.error(`Error processing message for user ${userId}:`, error);
        queue.shift();
        if (promise) {
          promise.reject(error);
        }
      }
    }

    this.processingQueues.set(userId, false);

    // Clean up pending promises
    if (queue.length === 0) {
      this.pendingPromises.delete(userId);
    }
  }

  sendToUser(userId, data) {
    const ws = this.connections.get(userId);
    if (!ws || ws.readyState !== 1) {
      return false;
    }

    return new Promise((resolve, reject) => {
      ws.send(JSON.stringify(data), error => {
        if (error) {
          console.error(`Error sending message to user ${userId}:`, error);
          this.handleConnectionError(userId);
          reject(error);
        } else {
          resolve(true);
        }
      });
    });
  }

  isConnected(userId) {
    const ws = this.connections.get(userId);
    return ws?.readyState === 1 && ws?.isAlive === true;
  }
}

module.exports = new WebSocketManager();
