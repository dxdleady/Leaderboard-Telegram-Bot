// api/bot.js
const { Telegraf } = require('telegraf');
const rawBody = require('raw-body');
const mongoose = require('mongoose');
const {
  connectToDatabase,
  initializeDatabase,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

// Global bot instance
let bot = null;

/**
 * Initialize Telegram bot with proper configuration
 */
const initBot = () => {
  console.log('Initializing bot...');

  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  const newBot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 90000, // Increased timeout for serverless environment
  });

  // Set up error handling
  newBot.catch(async (err, ctx) => {
    console.error('Bot error:', err);
    try {
      await ctx.reply('An error occurred. Please try again later.');
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  });

  // Basic commands (these will be overridden by command handlers)
  newBot.command('start', ctx => ctx.reply('Welcome to the bot!'));
  newBot.command('help', ctx => ctx.reply('Help message'));
  newBot.on('message', ctx => ctx.reply('Got your message'));

  console.log('Bot instance created successfully');
  return newBot;
};

/**
 * Set up webhook for Telegram updates
 */
const setupWebhook = async domain => {
  try {
    if (!bot) {
      throw new Error('Bot not initialized');
    }

    const webhookUrl = `https://${domain}/api/bot`;
    console.log('Setting webhook URL:', webhookUrl);

    // Remove existing webhook
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    // Set new webhook
    await bot.telegram.setWebhook(webhookUrl);

    // Verify webhook setup
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', webhookInfo);

    return true;
  } catch (error) {
    console.error('Webhook setup error:', error);
    return false;
  }
};

/**
 * Initialize all required services (database and bot)
 */
const initializeServices = async () => {
  try {
    console.log('Initializing services...');

    // Connect to database if not already connected
    if (mongoose.connection.readyState !== 1) {
      console.log('Connecting to database...');
      await connectToDatabase();
      await initializeDatabase();
      console.log('Database connection established');
    }

    // Initialize bot if not already initialized
    if (!bot) {
      bot = initBot();
      console.log('Setting up command handlers...');
      await setupCommandHandlers(bot);
      console.log('Setting up action handlers...');
      await setupActionHandlers(bot);
      console.log('All handlers setup complete');
    }

    return true;
  } catch (error) {
    console.error('Service initialization error:', error);
    return false;
  }
};

/**
 * Get health status of the bot service
 */
const getHealthStatus = async () => {
  try {
    let webhookInfo = null;
    if (bot) {
      webhookInfo = await bot.telegram.getWebhookInfo();
    }

    return {
      ok: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database:
        mongoose.connection?.readyState === 1 ? 'connected' : 'disconnected',
      botInitialized: bot !== null,
      webhook: webhookInfo,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
};

/**
 * Main request handler for Vercel serverless function
 */
const handler = async (request, response) => {
  try {
    // Health check endpoint
    if (request.method === 'GET') {
      const health = await getHealthStatus();
      return response.status(200).json(health);
    }

    // Handle webhook updates
    if (request.method === 'POST') {
      // Initialize services if needed
      await initializeServices();

      // Parse update from Telegram
      const buf = await rawBody(request);
      const update = JSON.parse(buf.toString());
      console.log('Received update:', JSON.stringify(update, null, 2));

      // Process update
      await bot.handleUpdate(update);
      return response.status(200).json({ ok: true });
    }

    // Method not allowed
    return response.status(405).json({
      error: 'Method not allowed',
      allowedMethods: ['GET', 'POST'],
    });
  } catch (error) {
    console.error('Handler error:', error);
    // Always return 200 to Telegram even on errors
    return response.status(200).json({
      ok: true,
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
  },
};

// Setup webhook on cold start if in production environment
if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  console.log('Production environment detected, setting up webhook...');
  initializeServices()
    .then(() => setupWebhook(process.env.VERCEL_URL))
    .then(success => {
      if (success) {
        console.log('Webhook setup complete');
      } else {
        console.error('Webhook setup failed');
      }
    })
    .catch(error => {
      console.error('Initialization error:', error);
    });
}

module.exports = handler;
