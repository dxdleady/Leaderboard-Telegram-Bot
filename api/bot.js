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

// Basic commands
bot.command('start', ctx => ctx.reply('Welcome to the bot!'));
bot.command('help', ctx => ctx.reply('Help message'));
bot.on('message', ctx => ctx.reply('Got your message'));

let wsServer = null;

const setupWebSocket = server => {
  if (typeof WebSocket === 'undefined') {
    const WebSocket = require('ws');
    const wss = new WebSocket.Server({
      server,
      path: '/ws',
      clientTracking: true,
    });

    wss.on('connection', ws => {
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('error', console.error);
    });

    // Heartbeat
    const interval = setInterval(() => {
      wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    wss.on('close', () => clearInterval(interval));

    return wss;
  }
  return null;
};

// Create the handler function
const handler = async (request, response) => {
  try {
    // Health check
    if (request.method === 'GET') {
      return response.status(200).json({
        ok: true,
        timestamp: new Date().toISOString(),
      });
    }

    // Handle webhook updates
    if (request.method === 'POST') {
      // Initialize bot
      const bot = new Telegraf(process.env.BOT_TOKEN);

      // Set basic commands
      bot.command('start', ctx => ctx.reply('Welcome!'));
      bot.command('help', ctx => ctx.reply('Help message'));
      bot.on('message', ctx => ctx.reply('Got your message'));

      try {
        const buf = await rawBody(request);
        const update = JSON.parse(buf.toString());
        console.log('Received update:', update);

        await bot.handleUpdate(update);
        return response.status(200).json({ ok: true });
      } catch (error) {
        console.error('Webhook error:', error);
        return response.status(200).json({ ok: true });
      }
    }

    // Method not allowed
    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Handler error:', error);
    return response.status(200).json({ ok: true });
  }
};

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

// Setup webhook if in production
if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  const webhookUrl = `https://${process.env.VERCEL_URL}/api/bot`;
  bot.telegram
    .setWebhook(webhookUrl)
    .then(() => console.log('Webhook set:', webhookUrl))
    .catch(console.error);
}

module.exports = {
  handler,
  testBotConnection, // Export for testing
};
