// api/bot.js
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const wsManager = require('../services/websocketManager');
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const config = require('../config/default');
const webhookHandler = require('../handlers/webhookHandler');
const {
  connectToDatabase,
  initializeDatabase,
  clearDatabase,
  resetUserProgress,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

let bot;
let wss;

// Export config for Vercel
module.exports = async (req, res) => {
  try {
    // Handle WebSocket upgrade requests
    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (!res.socket.server.ws) {
        // Initialize WebSocket server
        const server = createServer();
        const wss = new WebSocketServer({ noServer: true });
        res.socket.server.ws = wss;

        wss.on('connection', (ws, req) => {
          const userId = getUserIdFromRequest(req);
          if (userId) {
            wsManager.addConnection(userId, ws);
          } else {
            ws.close(1008, 'UserId is required');
          }
        });
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

    // Handle regular bot updates
    await bot(req, res);
  } catch (error) {
    console.error('API route error:', error);
    res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
};

function getUserIdFromRequest(req) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    return userId ? parseInt(userId) : null;
  } catch (error) {
    console.error('Error parsing userId from request:', error);
    return null;
  }
}

const setupWebSocketServer = server => {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    clientTracking: true,
  });

  wss.on('connection', (ws, request) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const userId = parseInt(url.searchParams.get('userId'));

      if (!userId) {
        console.error('WebSocket connection attempt without userId');
        ws.close(1008, 'UserId is required');
        return;
      }

      // Close existing connection if any
      if (wsManager.isConnected(userId)) {
        wsManager.removeConnection(userId);
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
    } catch (error) {
      console.error('Error handling WebSocket connection:', error);
      ws.close(1011, 'Internal Server Error');
    }
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

const startupCleanup = async () => {
  try {
    console.log('Starting cleanup process...');

    // Clear database
    await clearDatabase();

    // Initialize fresh database
    await initializeDatabase();

    // Clear any existing sessions
    global.userSessions = new Map();

    // Clear WebSocket connections
    wsManager.getActiveConnections().forEach(userId => {
      wsManager.removeConnection(userId);
    });

    console.log('Cleanup completed successfully');
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }
};

const setupAdditionalCommands = bot => {
  // Reset command for development and admin use
  bot.command('reset', async ctx => {
    try {
      if (
        process.env.NODE_ENV === 'development' ||
        config.bot.adminIds.includes(ctx.from.id)
      ) {
        await resetUserProgress(ctx.from.id);
        await ctx.reply(
          'Your quiz progress has been reset. You can start fresh now!'
        );
      } else {
        await ctx.reply('This command is only available for administrators.');
      }
    } catch (error) {
      console.error('Error in reset command:', error);
      await ctx.reply('Error resetting progress. Please try again later.');
    }
  });

  // Debug command for development
  if (process.env.NODE_ENV === 'development') {
    bot.command('debug', async ctx => {
      try {
        const debugInfo = {
          wsConnections: wsManager.getActiveConnections().length,
          dbStatus: mongoose.connection.readyState,
          sessionCount: global.userSessions?.size || 0,
        };
        await ctx.reply(`Debug info:\n${JSON.stringify(debugInfo, null, 2)}`);
      } catch (error) {
        console.error('Error in debug command:', error);
      }
    });
  }
};

const initializeBot = async (server = null) => {
  try {
    if (!bot) {
      bot = new Telegraf(config.bot.token);

      // Setup all handlers
      setupCommandHandlers(bot);
      setupActionHandlers(bot);
      setupAdditionalCommands(bot);

      if (process.env.NODE_ENV === 'production') {
        const domain = process.env.VERCEL_URL || process.env.DOMAIN;
        if (!domain) {
          throw new Error(
            'VERCEL_URL or DOMAIN environment variable is not set'
          );
        }

        const webhookUrl = `https://${domain}/api/bot`;
        console.log('Setting webhook URL:', webhookUrl);

        if (server) {
          wss = setupWebSocketServer(server);
          console.log('WebSocket server initialized');
        }

        try {
          await bot.telegram.deleteWebhook();
          await bot.telegram.setWebhook(webhookUrl);

          const webhookInfo = await bot.telegram.getWebhookInfo();
          console.log('Webhook set successfully:', webhookInfo);
        } catch (error) {
          console.error('Error setting webhook:', error);
          throw error;
        }
      } else {
        console.log('Starting bot in polling mode...');
        await bot.launch();
        console.log('Bot launched successfully in polling mode');
      }

      bot.catch(error => {
        console.error('Bot error:', error);
      });

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

  try {
    if (bot) {
      console.log('Stopping bot...');
      await bot.stop('SIGTERM');
    }

    if (wss) {
      console.log('Closing WebSocket server...');
      await new Promise(resolve => wss.close(resolve));
      console.log('WebSocket server closed');
    }

    wsManager.getActiveConnections().forEach(userId => {
      wsManager.removeConnection(userId);
    });

    if (mongoose.connection.readyState === 1) {
      console.log('Closing database connection...');
      await mongoose.connection.close();
    }

    console.log('Cleanup completed successfully');
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
};

const handler = async (req, res) => {
  try {
    await connectToDatabase();

    if (req.headers.upgrade?.toLowerCase() === 'websocket') {
      if (!wss) {
        wss = setupWebSocketServer(req.socket.server);
      }
      wss.handleUpgrade(req, req.socket, Buffer.alloc(0), ws => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    if (!bot) {
      bot = await initializeBot(req.socket?.server);
    }

    await webhookHandler(req, res, bot);
  } catch (error) {
    console.error('Error in API handler:', error);
    res.status(200).json({ ok: true });
  }
};

// Development mode startup with cleanup support
if (process.env.NODE_ENV !== 'production') {
  connectToDatabase()
    .then(async () => {
      if (process.argv.includes('cleanup')) {
        await startupCleanup();
      }
      return initializeBot();
    })
    .catch(error => {
      console.error('Failed to start bot:', error);
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

module.exports.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};
