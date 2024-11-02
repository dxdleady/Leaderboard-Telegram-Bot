const { Telegraf } = require('telegraf');
const rawBody = require('raw-body');
const mongoose = require('mongoose');
const {
  connectToDatabase,
  initializeDatabase,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

let bot = null;

const initBot = () => {
  console.log('[DEBUG] Starting bot initialization...');
  console.log('[DEBUG] BOT_TOKEN exists:', !!process.env.BOT_TOKEN);

  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  try {
    const newBot = new Telegraf(process.env.BOT_TOKEN, {
      handlerTimeout: 90000,
    });

    // Verify bot was created properly
    if (!newBot || typeof newBot.handleUpdate !== 'function') {
      throw new Error('Bot not properly initialized by Telegraf');
    }

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
    console.log('[DEBUG] Setting up webhook for domain:', domain);

    if (!bot) {
      console.log(
        '[DEBUG] Bot not initialized during webhook setup. Initializing...'
      );
      bot = initBot();
    }

    const webhookUrl = `https://${domain}/api/bot`;
    console.log('[DEBUG] Setting webhook URL:', webhookUrl);

    // Test bot connection before setting webhook
    try {
      const botInfo = await bot.telegram.getMe();
      console.log('[DEBUG] Bot info:', botInfo);
    } catch (error) {
      console.error('[DEBUG] Failed to get bot info:', error);
      return false;
    }

    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    const success = await bot.telegram.setWebhook(webhookUrl);

    console.log('[DEBUG] Webhook set success:', success);

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

    // Connect to database if not already connected
    if (mongoose.connection.readyState !== 1) {
      console.log('[DEBUG] Connecting to database...');
      await connectToDatabase();

      // Database cleanup if needed
      if (process.argv.includes('cleanup')) {
        console.log('[DEBUG] Cleanup flag detected, cleaning database...');
        await clearDatabase();
        console.log('[DEBUG] Database cleanup complete');
      }

      await initializeDatabase();
      console.log(
        '[DEBUG] Database connection status:',
        mongoose.connection.readyState
      );
    }

    // Initialize bot if not already initialized
    if (!bot) {
      console.log('[DEBUG] Initializing bot...');
      bot = initBot();
      await setupCommandHandlers(bot);
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

    if (request.method === 'POST') {
      console.log('[DEBUG] Received webhook POST');

      // Initialize services before handling update
      const initialized = await initializeServices();
      console.log('[DEBUG] Services initialized:', initialized);

      if (!bot) {
        console.error('[DEBUG] Bot still null after initialization!');
        throw new Error('Failed to initialize bot');
      }

      const buf = await rawBody(request);
      const update = JSON.parse(buf.toString());
      console.log('[DEBUG] Received update:', JSON.stringify(update, null, 2));

      // Double check bot exists and has handleUpdate method
      if (!bot || typeof bot.handleUpdate !== 'function') {
        console.error('[DEBUG] Bot not properly initialized:', bot);
        throw new Error('Bot not properly initialized');
      }

      await bot.handleUpdate(update);
      console.log('[DEBUG] Update handled successfully');
      return response.status(200).json({ ok: true });
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DEBUG] Handler error:', error);
    console.error('[DEBUG] Bot state:', !!bot);
    return response.status(200).json({
      ok: true,
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : 'Internal server error',
    });
  }
};

handler.config = {
  api: {
    bodyParser: false,
  },
};

// Immediate initialization in production
if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  console.log(
    '[DEBUG] Production environment detected. Starting initialization...'
  );
  initializeServices()
    .then(() => {
      console.log('[DEBUG] Services initialized, setting up webhook...');
      return setupWebhook(process.env.VERCEL_URL);
    })
    .then(success => {
      console.log('[DEBUG] Webhook setup finished. Success:', success);
    })
    .catch(error => {
      console.error('[DEBUG] Startup error:', error);
    });
}

module.exports = handler;
