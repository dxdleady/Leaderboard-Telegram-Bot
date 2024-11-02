// services/websocketManager.js
class WebSocketManager {
  constructor() {
    this.connections = new Map();
    this.messageQueues = new Map();
    this.processingQueues = new Map();
    this.reconnectTimeouts = new Map();
  }

  addConnection(userId, ws) {
    // Clear any existing reconnect timeout
    if (this.reconnectTimeouts.has(userId)) {
      clearTimeout(this.reconnectTimeouts.get(userId));
      this.reconnectTimeouts.delete(userId);
    }

    // Close existing connection if any
    this.removeConnection(userId);

    // Set up the new connection
    this.connections.set(userId, ws);
    this.initializeQueue(userId);

    // Set up error handling
    ws.on('error', error => {
      console.error(`WebSocket error for user ${userId}:`, error);
      this.handleConnectionError(userId);
    });

    ws.on('close', () => {
      this.handleConnectionError(userId);
    });

    // Process any pending messages
    this.processQueue(userId);
  }

  initializeQueue(userId) {
    if (!this.messageQueues.has(userId)) {
      this.messageQueues.set(userId, []);
    }
    this.processingQueues.set(userId, false);
  }

  removeConnection(userId) {
    const ws = this.connections.get(userId);
    if (ws) {
      try {
        ws.close();
      } catch (error) {
        console.error(`Error closing WebSocket for user ${userId}:`, error);
      }
    }
    this.connections.delete(userId);

    // Don't clear the message queue immediately, keep it for potential reconnection
    this.setReconnectTimeout(userId);
  }

  setReconnectTimeout(userId) {
    // Clear existing timeout if any
    if (this.reconnectTimeouts.has(userId)) {
      clearTimeout(this.reconnectTimeouts.get(userId));
    }

    // Set new timeout
    const timeout = setTimeout(() => {
      this.messageQueues.delete(userId);
      this.processingQueues.delete(userId);
      this.reconnectTimeouts.delete(userId);
    }, 5 * 60 * 1000); // 5 minutes timeout

    this.reconnectTimeouts.set(userId, timeout);
  }

  handleConnectionError(userId) {
    this.removeConnection(userId);
    // Pause queue processing but keep messages for potential reconnection
    this.processingQueues.set(userId, false);
  }

  isConnected(userId) {
    const ws = this.connections.get(userId);
    return ws?.readyState === 1; // WebSocket.OPEN
  }

  async queueMessage(userId, messageCallback) {
    if (!this.messageQueues.has(userId)) {
      this.initializeQueue(userId);
    }

    return new Promise((resolve, reject) => {
      this.messageQueues.get(userId).push({
        callback: messageCallback,
        resolve,
        reject,
        timestamp: Date.now(),
      });

      // Start processing if not already processing
      if (!this.processingQueues.get(userId)) {
        this.processQueue(userId);
      }
    });
  }

  async processQueue(userId) {
    if (!this.messageQueues.has(userId) || this.processingQueues.get(userId)) {
      return;
    }

    this.processingQueues.set(userId, true);
    const queue = this.messageQueues.get(userId);

    while (queue.length > 0 && this.isConnected(userId)) {
      const message = queue[0];

      try {
        // Check if message is too old (> 5 minutes)
        if (Date.now() - message.timestamp > 5 * 60 * 1000) {
          queue.shift();
          message.reject(new Error('Message timeout'));
          continue;
        }

        await message.callback();
        queue.shift();
        message.resolve();
      } catch (error) {
        console.error(`Error processing message for user ${userId}:`, error);
        queue.shift();
        message.reject(error);
      }
    }

    this.processingQueues.set(userId, false);
  }

  sendToUser(userId, data) {
    const ws = this.connections.get(userId);
    if (!ws || ws.readyState !== 1) {
      return false;
    }

    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error(`Error sending message to user ${userId}:`, error);
      this.handleConnectionError(userId);
      return false;
    }
  }

  updateQuizProgress(userId, progressData) {
    return this.sendToUser(userId, {
      type: 'quiz_progress',
      ...progressData,
    });
  }

  getActiveConnections() {
    return Array.from(this.connections.keys());
  }
}

module.exports = new WebSocketManager();
