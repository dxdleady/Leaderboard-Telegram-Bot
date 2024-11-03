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

let isInitializing = false;
let lastInitTime = 0;
const INIT_COOLDOWN = 5000;

// Enhanced bot initialization with connection check
const initBot = async (force = false) => {
  try {
    if (isInitializing) {
      console.log('[DEBUG] Bot initialization already in progress...');
      return null;
    }

    if (!force && bot && Date.now() - lastInitTime < INIT_COOLDOWN) {
      console.log('[DEBUG] Using existing bot instance');
      return bot;
    }

    isInitializing = true;
    console.log('[DEBUG] Starting bot initialization...');

    if (!process.env.BOT_TOKEN) {
      throw new Error('BOT_TOKEN environment variable is not set');
    }

    // Create new bot instance
    const newBot = new Telegraf(process.env.BOT_TOKEN, {
      handlerTimeout: 30000,
    });

    // Enhanced error handling
    newBot.catch(async (err, ctx) => {
      console.error('[DEBUG] Bot error:', err);
      try {
        await ctx.reply('An error occurred. Please try again later.');
      } catch (replyError) {
        console.error('[DEBUG] Error sending error message:', replyError);
      }
    });

    // Setup handlers
    console.log('[DEBUG] Setting up command handlers...');
    await setupCommandHandlers(newBot);

    console.log('[DEBUG] Setting up action handlers...');
    await setupActionHandlers(newBot);

    // Verify bot connection
    await newBot.telegram.getMe();

    bot = newBot;
    lastInitTime = Date.now();
    console.log('[DEBUG] Bot initialized successfully');
    return bot;
  } catch (error) {
    console.error('[DEBUG] Bot initialization error:', error);
    throw error;
  } finally {
    isInitializing = false;
  }
};

// Enhanced database connection with retry
const ensureDatabaseConnection = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (mongoose.connection.readyState === 1) {
        return true;
      }

      console.log(
        `[DEBUG] Attempting database connection (attempt ${i + 1}/${retries})`
      );
      await connectToDatabase();
      await initializeDatabase();
      return true;
    } catch (error) {
      console.error(
        `[DEBUG] Database connection attempt ${i + 1} failed:`,
        error
      );
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
  return false;
};

const setupWebhook = async (currentBot, domain) => {
  try {
    const webhookUrl = `https://${domain}/api/bot`;
    console.log('[DEBUG] Setting webhook URL:', webhookUrl);

    await currentBot.telegram.deleteWebhook();
    await currentBot.telegram.setWebhook(webhookUrl);

    const webhookInfo = await currentBot.telegram.getWebhookInfo();
    console.log('[DEBUG] Webhook info:', webhookInfo);
    return true;
  } catch (error) {
    console.error('[DEBUG] Webhook setup error:', error);
    return false;
  }
};

// Improved webhook handler
const handler = async (req, res) => {
  const startTime = Date.now();
  console.log(
    '[DEBUG] Received request:',
    req.method,
    'Start time:',
    new Date().toISOString()
  );

  try {
    // Health check endpoint
    if (req.method === 'GET') {
      const status = {
        ok: true,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          state: mongoose.connection.readyState,
          connected: mongoose.connection.readyState === 1,
        },
        bot: {
          initialized: !!bot,
          lastInit: lastInitTime ? new Date(lastInitTime).toISOString() : null,
        },
        environment: process.env.NODE_ENV,
      };
      return res.status(200).json(status);
    }

    // Handle webhook updates
    if (req.method === 'POST') {
      console.log('[DEBUG] Processing webhook update...');

      // Ensure database connection first
      await ensureDatabaseConnection();

      // Initialize or get bot instance
      const currentBot = await initBot();
      if (!currentBot) {
        throw new Error('Failed to initialize bot');
      }

      // Parse and process update
      const buf = await rawBody(req);
      const update = JSON.parse(buf.toString());

      console.log(
        '[DEBUG] Update type:',
        update.message
          ? 'message'
          : update.callback_query
          ? 'callback_query'
          : 'other'
      );

      // Process update with timeout
      const updatePromise = currentBot.handleUpdate(update);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Update processing timeout')), 25000)
      );

      await Promise.race([updatePromise, timeoutPromise]);

      const processingTime = Date.now() - startTime;
      console.log(
        '[DEBUG] Update processed successfully, took:',
        processingTime,
        'ms'
      );

      return res.status(200).json({
        ok: true,
        processingTime,
        botInitialized: !!bot,
        databaseConnected: mongoose.connection.readyState === 1,
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DEBUG] Handler error:', error);
    return res.status(200).json({
      ok: false,
      error: error.message,
      processingTime: Date.now() - startTime,
    });
  }
};

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

const startLocalBot = async () => {
  try {
    console.log('[DEBUG] Starting bot in local development mode...');

    // Ensure database connection
    await ensureDatabaseConnection();

    // Handle cleanup if requested
    if (process.argv.includes('cleanup')) {
      console.log('[DEBUG] Running database cleanup...');
      await clearDatabase();
      console.log('[DEBUG] Database cleanup completed');
      await initializeDatabase();
      console.log('[DEBUG] Database reinitialized');
    }

    // Initialize bot
    const currentBot = await initBot(true);
    if (!currentBot) {
      throw new Error('Failed to initialize bot for local mode');
    }

    // Start bot in polling mode
    await currentBot.launch({
      dropPendingUpdates: true,
    });

    console.log('[DEBUG] Bot successfully started in polling mode');

    // Enable graceful stop
    process.once('SIGINT', () => {
      console.log('[DEBUG] Received SIGINT signal');
      currentBot?.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      console.log('[DEBUG] Received SIGTERM signal');
      currentBot?.stop('SIGTERM');
    });
  } catch (error) {
    console.error('[DEBUG] Failed to start bot in local mode:', error);
    throw error;
  }
};

// Environment-specific initialization
if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  // Production environment (Vercel)
  console.log('[DEBUG] Production environment detected, setting up webhook...');
  (async () => {
    try {
      await ensureDatabaseConnection();
      const currentBot = await initBot(true);
      if (currentBot) {
        await setupWebhook(currentBot, process.env.VERCEL_URL);
      }
    } catch (error) {
      console.error('[DEBUG] Production setup error:', error);
    }
  })();
} else if (require.main === module) {
  // Local development
  console.log('[DEBUG] Starting in local development mode');
  if (process.argv.includes('cleanup')) {
    console.log('[DEBUG] Cleanup mode enabled');
  }
  startLocalBot().catch(error => {
    console.error('[DEBUG] Local startup error:', error);
    process.exit(1);
  });
}

module.exports = handler;
