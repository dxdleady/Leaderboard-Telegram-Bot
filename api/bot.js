const { Telegraf } = require('telegraf');
const rawBody = require('raw-body');
const mongoose = require('mongoose');
const {
  clearDatabase,
  connectToDatabase,
  initializeDatabase,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

// Global bot instance
let bot = null;

const initBot = () => {
  console.log('[DEBUG] Starting bot initialization...');
  console.log('[DEBUG] BOT_TOKEN exists:', !!process.env.BOT_TOKEN);

  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  try {
    const newBot = new Telegraf(process.env.BOT_TOKEN);

    // Set up error handling
    newBot.catch(async (err, ctx) => {
      console.error('[DEBUG] Bot error:', err);
      try {
        await ctx.reply('An error occurred. Please try again later.');
      } catch (replyError) {
        console.error('[DEBUG] Error sending error message:', replyError);
      }
    });

    console.log('[DEBUG] Bot instance created successfully');
    return newBot;
  } catch (error) {
    console.error('[DEBUG] Error in bot initialization:', error);
    throw error;
  }
};

const setupWebhook = async domain => {
  try {
    const webhookUrl = `https://${domain}/api/bot`;
    console.log('[DEBUG] Setting webhook URL:', webhookUrl);

    await bot.telegram.deleteWebhook();
    await bot.telegram.setWebhook(webhookUrl);

    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('[DEBUG] Webhook info:', webhookInfo);
    return true;
  } catch (error) {
    console.error('[DEBUG] Webhook setup error:', error);
    return false;
  }
};

const initializeServices = async () => {
  try {
    console.log('[DEBUG] Starting services initialization...');

    // Connect to database if not connected
    if (mongoose.connection.readyState !== 1) {
      console.log('[DEBUG] Connecting to database...');
      await connectToDatabase();

      if (process.argv.includes('cleanup')) {
        console.log('[DEBUG] Running database cleanup...');
        await clearDatabase();
      }

      await initializeDatabase();
      console.log('[DEBUG] Database initialized');
    }

    // Initialize bot if not initialized
    if (!bot) {
      console.log('[DEBUG] Creating bot instance...');
      bot = initBot();

      console.log('[DEBUG] Setting up command handlers...');
      await setupCommandHandlers(bot);

      console.log('[DEBUG] Setting up action handlers...');
      await setupActionHandlers(bot);

      console.log('[DEBUG] Bot setup complete');
    }

    return true;
  } catch (error) {
    console.error('[DEBUG] Service initialization error:', error);
    return false;
  }
};

const handler = async (request, response) => {
  try {
    console.log('[DEBUG] Received request:', request.method);

    // Health check endpoint
    if (request.method === 'GET') {
      const health = {
        ok: true,
        timestamp: new Date().toISOString(),
        database:
          mongoose.connection?.readyState === 1 ? 'connected' : 'disconnected',
        botInitialized: !!bot,
        environment: process.env.NODE_ENV,
        vercelUrl: process.env.VERCEL_URL,
      };
      console.log('[DEBUG] Health check:', health);
      return response.status(200).json(health);
    }

    // Handle webhook updates
    if (request.method === 'POST') {
      console.log('[DEBUG] Received webhook POST');

      if (!bot) {
        console.log('[DEBUG] Bot not initialized, initializing services...');
        await initializeServices();
      }

      const buf = await rawBody(request);
      const update = JSON.parse(buf.toString());
      console.log('[DEBUG] Received update:', update);

      await bot.handleUpdate(update);
      return response.status(200).json({ ok: true });
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DEBUG] Handler error:', error);
    return response.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
};

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
  },
};

// Setup webhook in production
if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  console.log('[DEBUG] Production environment detected, initializing...');
  initializeServices()
    .then(() => {
      console.log('[DEBUG] Services initialized, setting up webhook...');
      return setupWebhook(process.env.VERCEL_URL);
    })
    .then(() => {
      console.log('[DEBUG] Webhook setup complete');
    })
    .catch(error => {
      console.error('[DEBUG] Startup error:', error);
    });
}

// Local development startup
if (require.main === module) {
  console.log('[DEBUG] Local development mode detected');
  initializeServices()
    .then(async () => {
      console.log('[DEBUG] Services initialized, starting bot polling...');
      await bot.launch({
        dropPendingUpdates: true,
      });
      console.log('[DEBUG] Bot started in polling mode');
    })
    .catch(error => {
      console.error('[DEBUG] Startup error:', error);
      process.exit(1);
    });

  // Enable graceful stop
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

module.exports = handler;
