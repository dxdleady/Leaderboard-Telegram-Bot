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

// First, modify the setupWebhook function
const setupWebhook = async (currentBot, domain) => {
  try {
    const webhookUrl = `https://${domain}/api/bot`;
    console.log('[DEBUG] Setting webhook URL:', webhookUrl);

    // First delete existing webhook with dropping updates
    await currentBot.telegram.deleteWebhook({ drop_pending_updates: true });

    // Set webhook with more options
    await currentBot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 100,
    });

    // Verify webhook setup
    const webhookInfo = await currentBot.telegram.getWebhookInfo();
    console.log('[DEBUG] Webhook info:', webhookInfo);

    // Verify the URL matches
    if (webhookInfo.url !== webhookUrl) {
      console.error('[DEBUG] Webhook URL mismatch:', {
        expected: webhookUrl,
        actual: webhookInfo.url,
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error('[DEBUG] Webhook setup error:', error);
    return false;
  }
};

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
        vercelUrl: process.env.VERCEL_URL,
      };
      return res.status(200).json(status);
    }

    // Handle webhook updates
    if (req.method === 'POST') {
      console.log('[DEBUG] Processing webhook update...');

      try {
        // Get raw body first
        const buf = await rawBody(req);
        const text = buf.toString();
        console.log('[DEBUG] Received update data length:', text.length);

        // Parse update after getting body
        const update = JSON.parse(text);

        // Ensure database connection
        await ensureDatabaseConnection();

        // Get bot instance
        const currentBot = await initBot();
        if (!currentBot) {
          throw new Error('Failed to initialize bot');
        }

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
          setTimeout(
            () => reject(new Error('Update processing timeout')),
            25000
          )
        );

        await Promise.race([updatePromise, timeoutPromise]);

        const processingTime = Date.now() - startTime;
        console.log(
          '[DEBUG] Update processed successfully, took:',
          processingTime,
          'ms'
        );

        // Always return success to Telegram
        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('[DEBUG] Error processing webhook update:', error);
        // Still return success to Telegram to prevent retries
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DEBUG] Handler error:', error);
    // Always return success to Telegram
    return res.status(200).json({ ok: true });
  }
};

// And update the production initialization
if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  console.log('[DEBUG] Production environment detected, setting up webhook...');
  (async () => {
    try {
      // Ensure clean state
      await ensureDatabaseConnection();
      const currentBot = await initBot(true);

      if (currentBot) {
        // Retry webhook setup if needed
        let retries = 3;
        let success = false;

        while (retries > 0 && !success) {
          console.log(`[DEBUG] Attempting webhook setup (${4 - retries}/3)...`);
          success = await setupWebhook(currentBot, process.env.VERCEL_URL);
          if (!success && retries > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          retries--;
        }

        if (!success) {
          throw new Error('Failed to set up webhook after all retries');
        }
      }
    } catch (error) {
      console.error('[DEBUG] Production setup error:', error);
    }
  })();
}

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

const handleDatabaseCleanup = async () => {
  if (process.argv.includes('cleanup')) {
    console.log('[DEBUG] Running database cleanup...');
    await clearDatabase();
    console.log('[DEBUG] Database cleanup completed');
    await initializeDatabase();
    console.log('[DEBUG] Database reinitialized');
    return true;
  }
  return false;
};

const startLocalBot = async () => {
  try {
    console.log('[DEBUG] Starting bot in local development mode...');

    // Ensure database connection
    await ensureDatabaseConnection();

    // Handle cleanup if requested
    const cleanupPerformed = await handleDatabaseCleanup();
    if (cleanupPerformed) {
      console.log('[DEBUG] Database cleanup and reinitialization completed');
    } else {
      console.log('[DEBUG] No cleanup requested, using existing database');
    }

    // Initialize bot
    const currentBot = await initBot(true);
    if (!currentBot) {
      throw new Error('Failed to initialize bot for local mode');
    }

    // Remove any existing webhook
    console.log('[DEBUG] Removing existing webhook...');
    await currentBot.telegram.deleteWebhook({ drop_pending_updates: true });

    // Start bot in polling mode
    console.log('[DEBUG] Starting polling mode...');
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

    return currentBot;
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
        let retries = 3;
        let success = false;

        while (retries > 0 && !success) {
          console.log(`[DEBUG] Attempting webhook setup (${4 - retries}/3)...`);
          success = await setupWebhook(currentBot, process.env.VERCEL_URL);
          if (!success && retries > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          retries--;
        }

        if (!success) {
          throw new Error('Failed to set up webhook after all retries');
        }
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
