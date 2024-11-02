// api/bot.js
const { Telegraf } = require('telegraf');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const mongoose = require('mongoose');
const rawBody = require('raw-body');
const wsManager = require('../services/websocketManager');
const config = require('../config/default');
const {
  connectToDatabase,
  initializeDatabase,
  clearDatabase,
  resetUserProgress,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

// Initialize bot instance
const bot = new Telegraf(process.env.BOT_TOKEN);

// Setup command and action handlers
setupCommandHandlers(bot);
setupActionHandlers(bot);

let wss;

// WebSocket setup helper
const setupWebSocket = server => {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    clientTracking: true,
  });

  wss.on('connection', (ws, request) => {
    try {
      const userId = parseInt(
        new URL(request.url, `http://${request.headers.host}`).searchParams.get(
          'userId'
        )
      );

      if (!userId) {
        ws.close(1008, 'UserId is required');
        return;
      }

      ws.isAlive = true;
      ws.userId = userId;

      // Handle existing connections
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

  // Heartbeat check
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

// Parse raw body helper
async function parseRawBody(req) {
  const rawReqBody = await rawBody(req);
  return JSON.parse(rawReqBody.toString());
}

// Admin commands setup
const setupAdminCommands = () => {
  // Reset command
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
      console.error('Reset command error:', error);
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
        console.error('Debug command error:', error);
      }
    });
  }
};

// Bot initialization
const initializeBot = async () => {
  try {
    if (process.env.NODE_ENV === 'production') {
      const domain = process.env.VERCEL_URL || process.env.DOMAIN;
      if (!domain) {
        throw new Error('VERCEL_URL or DOMAIN environment variable is not set');
      }

      const webhookUrl = `https://${domain}/api/bot`;

      await bot.telegram.deleteWebhook();
      await bot.telegram.setWebhook(webhookUrl);

      const webhookInfo = await bot.telegram.getWebhookInfo();
      console.log('Webhook configured:', webhookInfo);
    } else {
      await bot.launch();
      console.log('Bot launched in polling mode');
    }

    setupAdminCommands();

    bot.catch(error => {
      console.error('Bot error:', error);
    });

    return bot;
  } catch (error) {
    console.error('Bot initialization error:', error);
    throw error;
  }
};

// Cleanup function
const cleanup = async () => {
  console.log('Starting cleanup...');

  try {
    if (bot) {
      await bot.stop('SIGTERM');
    }

    if (wss) {
      await new Promise(resolve => wss.close(resolve));
    }

    wsManager.getActiveConnections().forEach(userId => {
      wsManager.removeConnection(userId);
    });

    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }

    console.log('Cleanup completed');
  } catch (error) {
    console.error('Cleanup error:', error);
    process.exit(1);
  }
};

// Main request handler
const handler = async (req, res) => {
  try {
    // Handle WebSocket upgrades
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

    // Connect to database
    await connectToDatabase();

    // Health check
    if (req.method === 'GET') {
      return res.status(200).json({
        status: 'healthy',
        webhook: true,
        timestamp: new Date().toISOString(),
        connections: wsManager.getActiveConnections().length,
      });
    }

    // Handle webhook updates
    if (req.method === 'POST') {
      const update = await parseRawBody(req);
      await bot.handleUpdate(update);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Request handler error:', error);
    return res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
};

// Initialize bot on startup
initializeBot().catch(console.error);

// Setup cleanup handlers
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);

// Export configuration and handler
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
