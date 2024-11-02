// api/bot.js
const { Telegraf } = require('telegraf');
const { WebSocketServer } = require('ws');
const rawBody = require('raw-body');
const wsManager = require('../services/websocketManager');
const config = require('../config/default');
const {
  connectToDatabase,
  initializeDatabase,
  clearDatabase,
  resetUserProgress,
  closeDatabase,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

const initBot = () => {
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  const bot = new Telegraf(process.env.BOT_TOKEN);
  bot.catch((err, ctx) => {
    console.error('Bot error:', err);
    ctx
      .reply('An error occurred. Please try again later.')
      .catch(console.error);
  });

  return bot;
};

const bot = initBot();
setupCommandHandlers(bot);
setupActionHandlers(bot);

const setupWebSocket = server => {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    clientTracking: true,
  });

  wss.on('connection', async (ws, request) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const userId = parseInt(url.searchParams.get('userId'));

      if (!userId) {
        ws.close(1008, 'UserId is required');
        return;
      }

      ws.isAlive = true;
      ws.userId = userId;

      await connectToDatabase();

      if (wsManager.isConnected(userId)) {
        wsManager.removeConnection(userId);
      }

      wsManager.addConnection(userId, ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('close', () => {
        wsManager.removeConnection(userId);
      });

      ws.on('error', error => {
        console.error(`WebSocket error for user ${userId}:`, error);
        wsManager.removeConnection(userId);
      });
    } catch (error) {
      console.error('WebSocket connection error:', error);
      ws.close(1011, 'Internal Server Error');
    }
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) {
        wsManager.removeConnection(ws.userId);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
};

const handler = async (req, res) => {
  try {
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (!res.socket.server.ws) {
        res.socket.server.ws = setupWebSocket(res.socket.server);
      }

      res.socket.server.ws.handleUpgrade(
        req,
        req.socket,
        Buffer.alloc(0),
        ws => {
          res.socket.server.ws.emit('connection', ws, req);
        }
      );
      return;
    }

    await connectToDatabase();

    if (req.method === 'GET') {
      const health = await getHealthStatus();
      return res.status(200).json(health);
    }

    if (req.method === 'POST') {
      const rawReqBody = await rawBody(req);
      const update = JSON.parse(rawReqBody.toString());

      const timeoutMs = 8000;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Update processing timeout')),
          timeoutMs
        );
      });

      await Promise.race([bot.handleUpdate(update), timeoutPromise]);

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Request handler error:', error);
    return res.status(200).json({ ok: true, error: error.message });
  }
};

const getHealthStatus = async () => {
  try {
    const webhookInfo = await bot.telegram.getWebhookInfo();
    return {
      status: 'healthy',
      webhook: webhookInfo,
      timestamp: new Date().toISOString(),
      connections: wsManager.getActiveConnections().length,
      database:
        mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
};

const initialize = async () => {
  try {
    await connectToDatabase();
    await initializeDatabase();

    if (process.env.NODE_ENV === 'production') {
      const domain = process.env.VERCEL_URL || process.env.DOMAIN;
      if (!domain) {
        throw new Error('VERCEL_URL or DOMAIN environment variable is not set');
      }

      const webhookUrl = `https://${domain}/api/bot`;
      console.log('Setting webhook URL:', webhookUrl);

      await bot.telegram.deleteWebhook();
      await bot.telegram.setWebhook(webhookUrl);

      const webhookInfo = await bot.telegram.getWebhookInfo();
      console.log('Webhook configured:', webhookInfo);
      return webhookInfo;
    } else {
      if (process.argv.includes('cleanup')) {
        console.log('Cleaning database...');
        await clearDatabase();
        await initializeDatabase();
        console.log('Database reinitialized with fresh data.');
      }
      console.log('Starting bot in polling mode...');
      await bot.launch();
      console.log('Bot launched in polling mode');
    }
  } catch (error) {
    console.error('Initialization error:', error);
    throw error;
  }
};

if (require.main === module) {
  initialize().catch(error => {
    console.error('Failed to initialize bot:', error);
    process.exit(1);
  });
}

handler.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

module.exports = handler;

// services/websocketManager.js
class WebSocketManager {
  constructor() {
    this.connections = new Map();
    this.messageQueues = new Map();
    this.processingQueues = new Map();
    this.reconnectTimeouts = new Map();
  }

  addConnection(userId, ws) {
    if (this.reconnectTimeouts.has(userId)) {
      clearTimeout(this.reconnectTimeouts.get(userId));
      this.reconnectTimeouts.delete(userId);
    }

    this.removeConnection(userId);
    this.connections.set(userId, ws);
    this.initializeQueue(userId);

    ws.on('error', error => {
      console.error(`WebSocket error for user ${userId}:`, error);
      this.handleConnectionError(userId);
    });

    ws.on('close', () => {
      this.handleConnectionError(userId);
    });

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
    this.setReconnectTimeout(userId);
  }

  setReconnectTimeout(userId) {
    if (this.reconnectTimeouts.has(userId)) {
      clearTimeout(this.reconnectTimeouts.get(userId));
    }

    const timeout = setTimeout(() => {
      this.messageQueues.delete(userId);
      this.processingQueues.delete(userId);
      this.reconnectTimeouts.delete(userId);
    }, 5 * 60 * 1000);

    this.reconnectTimeouts.set(userId, timeout);
  }

  handleConnectionError(userId) {
    this.removeConnection(userId);
    this.processingQueues.set(userId, false);
  }

  isConnected(userId) {
    const ws = this.connections.get(userId);
    return ws?.readyState === 1;
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

let isConnected = false;

module.exports = {
  connectToDatabase,
  clearDatabase,
  initializeDatabase,
  resetUserProgress,
  closeDatabase,
  isConnected: () => isConnected,
};
