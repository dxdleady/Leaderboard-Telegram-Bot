// bot.js
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env' : '.env.local',
});

const { Telegraf } = require('telegraf');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const config = require('../config/default');
const webhookHandler = require('../handlers/webhookHandler');
const wsManager = require('../services/websocketManager');
const {
  connectToDatabase,
  initializeDatabase,
  clearDatabase,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

let bot;
let wss;

const setupWebSocketServer = server => {
  wss = new WebSocket.Server({
    server,
    path: '/ws',
    clientTracking: true,
  });

  wss.on('connection', (ws, request) => {
    // Extract user ID from URL parameters
    const url = new URL(request.url, `http://${request.headers.host}`);
    const userId = parseInt(url.searchParams.get('userId'));

    if (!userId) {
      console.error('WebSocket connection attempt without userId');
      ws.close(1008, 'UserId is required');
      return;
    }

    ws.isAlive = true;
    ws.userId = userId;

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
  });

  // Setup heartbeat interval
  const interval = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) {
        wsManager.removeConnection(ws.userId);
        return ws.terminate();
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  return wss;
};

const initializeBot = async (server = null) => {
  try {
    if (!bot) {
      bot = new Telegraf(config.bot.token);

      // Setup handlers
      setupCommandHandlers(bot);
      setupActionHandlers(bot);

      if (process.env.NODE_ENV === 'production') {
        const domain = process.env.VERCEL_URL;
        if (!domain) {
          throw new Error('VERCEL_URL environment variable is not set');
        }

        const webhookUrl = `https://${domain}/api/bot`;
        console.log('Setting webhook URL:', webhookUrl);

        // Setup WebSocket server if server instance is provided
        if (server) {
          const wss = setupWebSocketServer(server);
          console.log('WebSocket server initialized');
        }

        try {
          // Delete existing webhook before setting new one
          await bot.telegram.deleteWebhook();
          await bot.telegram.setWebhook(webhookUrl);

          const webhookInfo = await bot.telegram.getWebhookInfo();
          console.log('Webhook set successfully:', webhookInfo);
        } catch (error) {
          console.error('Error setting webhook:', error);
          throw error;
        }
      } else {
        // Development mode - use polling
        console.log('Starting bot in polling mode...');
        await bot.launch();
        console.log('Bot launched successfully in polling mode');
      }

      // Handle errors
      bot.catch(error => {
        console.error('Bot error:', error);
      });

      // Graceful shutdown
      process.once('SIGINT', () => cleanup());
      process.once('SIGTERM', () => cleanup());
    }

    return bot;
  } catch (error) {
    console.error('Failed to initialize bot:', error);
    throw error;
  }
};

const cleanup = async () => {
  console.log('Performing cleanup...');

  if (bot) {
    console.log('Stopping bot...');
    await bot.stop('SIGTERM');
  }

  if (wss) {
    console.log('Closing WebSocket server...');
    wss.close(() => {
      console.log('WebSocket server closed');
    });
  }

  // Close all active WebSocket connections
  wsManager.connections.forEach((ws, userId) => {
    wsManager.removeConnection(userId);
  });

  // Close database connection
  if (mongoose.connection.readyState === 1) {
    console.log('Closing database connection...');
    await mongoose.connection.close();
  }

  console.log('Cleanup completed');
};

// Development mode startup
if (process.env.NODE_ENV !== 'production') {
  connectToDatabase()
    .then(async () => {
      if (process.argv.includes('cleanup')) {
        console.log('Cleaning database...');
        await clearDatabase();
        await initializeDatabase();
        console.log('Database reinitialized with fresh data.');
      }
      return initializeBot();
    })
    .catch(error => {
      console.error('Failed to start bot:', error);
      process.exit(1);
    });
}

// Export handler for API endpoint
module.exports = async (req, res) => {
  try {
    await connectToDatabase();

    if (!bot) {
      // Initialize bot with req.socket.server for WebSocket support
      bot = await initializeBot(req.socket.server);
    }

    return webhookHandler(req, res, bot);
  } catch (error) {
    console.error('Error in API handler:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
