// api/bot.js
const { Telegraf } = require('telegraf');
const { WebSocketServer } = require('ws');
const rawBody = require('raw-body');
const mongoose = require('mongoose');
const wsManager = require('../services/websocketManager');
const config = require('../config/default');
const {
  clearDatabase,
  connectToDatabase,
  initializeDatabase,
} = require('../services/database');

// Import handlers - make sure these paths match your project structure
const { setupCommandHandlers } = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

// Initialize the bot
let bot = null;

const initBot = () => {
  console.log('Initializing bot...');

  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  const newBot = new Telegraf(process.env.BOT_TOKEN);

  newBot.catch(async (err, ctx) => {
    console.error('Bot error:', err);
    try {
      await ctx.reply('An error occurred. Please try again later.');
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  });

  console.log('Bot instance created successfully');
  return newBot;
};

// Create bot instance
try {
  bot = initBot();
} catch (error) {
  console.error('Failed to initialize bot:', error);
  process.exit(1);
}

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

      // Initialize connection before adding to manager
      ws.on('error', error => {
        console.error(`WebSocket error for user ${userId}:`, error);
        wsManager.removeConnection(userId);
      });

      ws.on('close', () => {
        wsManager.removeConnection(userId);
      });

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      wsManager.addConnection(userId, ws);
      console.log(`WebSocket connected for user ${userId}`);
    } catch (error) {
      console.error('WebSocket connection error:', error);
      ws.close(1011, 'Internal Server Error');
    }
  });

  // Heartbeat interval
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

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
};

// Serverless function handler
const handler = async (req, res) => {
  // Log request details for debugging
  console.log('Request received:', {
    method: req.method,
    url: req.url,
    headers: req.headers,
  });

  try {
    // Health check endpoint
    if (req.method === 'GET') {
      // Get webhook info for health check
      try {
        const webhookInfo = await bot.telegram.getWebhookInfo();
        return res.status(200).json({
          ok: true,
          timestamp: new Date().toISOString(),
          webhook: webhookInfo,
        });
      } catch (error) {
        console.error('Error getting webhook info:', error);
        return res.status(200).json({
          ok: true,
          error: error.message,
        });
      }
    }

    // Handle webhook updates
    if (req.method === 'POST') {
      console.log('Received POST request');

      // Get the raw body
      const buf = await rawBody(req);
      console.log('Raw body received:', buf.toString());

      // Parse update
      const update = JSON.parse(buf.toString());
      console.log('Update parsed:', update);

      // Process update
      try {
        await bot.handleUpdate(update);
        console.log('Update processed successfully');
      } catch (error) {
        console.error('Error processing update:', error);
      }

      // Always return success to Telegram
      return res.status(200).json({ ok: true });
    }

    // Handle unsupported methods
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Handler error:', error);
    // Always return 200 to Telegram even on error
    return res.status(200).json({ ok: true });
  }
};

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
  },
};

// Setup webhook function
const setupWebhook = async domain => {
  try {
    console.log('Setting up webhook for domain:', domain);
    const webhookUrl = `https://${domain}/api/bot`;

    // Remove existing webhook
    console.log('Removing existing webhook...');
    await bot.telegram.deleteWebhook();

    // Set new webhook
    console.log('Setting new webhook to:', webhookUrl);
    const success = await bot.telegram.setWebhook(webhookUrl);

    if (success) {
      console.log('Webhook set successfully');
      const webhookInfo = await bot.telegram.getWebhookInfo();
      console.log('Webhook info:', webhookInfo);
    } else {
      console.error('Failed to set webhook');
    }
  } catch (error) {
    console.error('Error setting webhook:', error);
  }
};

// Auto-setup webhook if running on Vercel
if (process.env.VERCEL_URL) {
  console.log('Vercel environment detected, setting up webhook...');
  setupWebhook(process.env.VERCEL_URL).catch(console.error);
}

const getHealthStatus = async () => {
  try {
    const webhookInfo = await bot.telegram.getWebhookInfo();
    return {
      status: 'healthy',
      webhook: webhookInfo,
      timestamp: new Date().toISOString(),
      connections: wsManager.getActiveConnections().length,
      database:
        mongoose.connection?.readyState === 1 ? 'connected' : 'disconnected',
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
};

const setupHandlers = async bot => {
  console.log('Setting up command handlers...');
  const setupCommandHandlers = require('../handlers/commandHandlers');
  await setupCommandHandlers(bot);
  console.log('Command handlers setup complete');

  console.log('Setting up action handlers...');
  const { setupActionHandlers } = require('../handlers/actionHandlers');
  await setupActionHandlers(bot);
  console.log('Action handlers setup complete');
};

const initialize = async () => {
  try {
    console.log('Starting initialization process...');

    // Connect to database
    console.log('Connecting to database...');
    await connectToDatabase();
    console.log('Database connection established');

    if (process.argv.includes('cleanup')) {
      console.log('Cleaning database...');
      await clearDatabase();
    }

    // Initialize database
    console.log('Initializing database...');
    await initializeDatabase();

    console.log('Database initialization complete');
    // Initialize bot
    console.log('Creating bot instance...');
    bot = initBot();
    console.log('Bot instance created');

    // Setup handlers
    console.log('Setting up handlers...');
    await setupHandlers(bot);
    console.log('Handlers setup complete');

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
    } else {
      console.log('Development environment detected, starting polling mode');
      await startPolling(bot);
    }

    console.log('Initialization complete!');
  } catch (error) {
    console.error('Initialization error:', error);
    throw error;
  }
};

const startPolling = async bot => {
  try {
    console.log('Starting bot in polling mode...');
    await bot.launch({
      dropPendingUpdates: true,
      polling: {
        timeout: 30,
        limit: 100,
      },
    });
    console.log('Bot is running in polling mode');

    // Setup shutdown handlers
    process.once('SIGINT', () => {
      console.log('SIGINT received, stopping bot...');
      bot.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      console.log('SIGTERM received, stopping bot...');
      bot.stop('SIGTERM');
    });

    return true;
  } catch (error) {
    console.error('Error starting polling mode:', error);
    throw error;
  }
};

// Modified initialization for direct execution
if (require.main === module) {
  initialize().catch(error => {
    console.error('Failed to initialize bot:', error);
    if (error.stack) {
      console.error('Error stack:', error.stack);
    }
    process.exit(1);
  });
}

// Test connection function
const testBotConnection = async () => {
  try {
    console.log('Testing bot connection...');
    const me = await bot.telegram.getMe();
    console.log('Bot connection successful:', me);
    return true;
  } catch (error) {
    console.error('Bot connection test failed:', error);
    return false;
  }
};

module.exports = {
  handler,
  testBotConnection, // Export for testing
};

// Configure serverless function settings
handler.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};
