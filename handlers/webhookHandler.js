// api/bot.js
const { Telegraf } = require('telegraf');
const { WebSocketServer } = require('ws');
const rawBody = require('raw-body');
const mongoose = require('mongoose');
const wsManager = require('../services/websocketManager');
const config = require('../config/default');
const {
  connectToDatabase,
  initializeDatabase,
} = require('../services/database');

let bot = null;
let lastInitTime = 0;

const verifyTelegramWebhook = (token, body, signature) => {
  if (!signature) return false;

  const secret = crypto.createHash('sha256').update(token).digest();

  const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');

  return hmac === signature;
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

      // Get raw body
      const buf = await rawBody(req);
      const text = buf.toString();

      // Verify webhook signature
      const telegramSignature = req.headers['x-telegram-bot-api-secret-token'];

      if (
        !verifyTelegramWebhook(process.env.BOT_TOKEN, text, telegramSignature)
      ) {
        console.error('[DEBUG] Invalid webhook signature');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      try {
        const update = JSON.parse(text);

        // Initialize or get bot instance
        const currentBot = bot || initBot();
        if (!currentBot) {
          throw new Error('Failed to initialize bot');
        }

        // Process update
        await currentBot.handleUpdate(update);

        const processingTime = Date.now() - startTime;
        console.log(
          '[DEBUG] Update processed successfully, took:',
          processingTime,
          'ms'
        );

        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('[DEBUG] Error processing webhook update:', error);
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DEBUG] Handler error:', error);
    return res.status(200).json({ ok: true });
  }
};

// Initialize bot
const initBot = () => {
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN environment variable is not set');
  }

  const newBot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 8000, // Set timeout for handlers
  });

  // Enhanced error handling
  newBot.catch(async (err, ctx) => {
    console.error('Bot error:', err);
    try {
      await ctx.reply('An error occurred. Please try again later.');
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  });

  return newBot;
};

const setupWebhook = async (currentBot, domain) => {
  try {
    const webhookUrl = `https://${domain}/api/bot`;
    console.log('[DEBUG] Setting webhook URL:', webhookUrl);

    // Generate a secret token for webhook verification
    const secretToken = crypto.randomBytes(32).toString('hex');

    // Delete existing webhook first
    await currentBot.telegram.deleteWebhook({ drop_pending_updates: true });

    // Set up new webhook with secret token
    await currentBot.telegram.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 100,
      secret_token: secretToken, // Add secret token for verification
    });

    // Store the secret token in environment variables or your config
    process.env.WEBHOOK_SECRET_TOKEN = secretToken;

    // Verify webhook setup
    const webhookInfo = await currentBot.telegram.getWebhookInfo();
    console.log('[DEBUG] Webhook info:', webhookInfo);

    if (webhookInfo.url !== webhookUrl) {
      throw new Error('Webhook URL mismatch');
    }

    return true;
  } catch (error) {
    console.error('[DEBUG] Webhook setup error:', error);
    return false;
  }
};

// Updated production initialization
if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  console.log('[DEBUG] Production environment detected, setting up webhook...');
  (async () => {
    try {
      // Ensure clean initialization
      await ensureDatabaseConnection();
      const currentBot = await initBot(true);

      if (!currentBot) {
        throw new Error('Bot initialization failed');
      }

      // Set up webhook with retries
      let retries = 3;
      let success = false;

      while (retries > 0 && !success) {
        try {
          await setupWebhook(currentBot, process.env.VERCEL_URL);
          success = true;
        } catch (error) {
          console.error(
            `[DEBUG] Webhook setup attempt ${4 - retries} failed:`,
            error
          );
          retries--;
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      if (!success) {
        throw new Error('Failed to set up webhook after all retries');
      }
    } catch (error) {
      console.error('[DEBUG] Production setup error:', error);
    }
  })();
}
// Initialize function
const initialize = async () => {
  try {
    // Connect to database
    await connectToDatabase();
    console.log('Database connected');

    // Create bot instance
    bot = initBot();
    console.log('Bot instance created');

    // Setup command and action handlers
    const setupCommandHandlers = require('../handlers/commandHandlers');
    const { setupActionHandlers } = require('../handlers/actionHandlers');

    await setupCommandHandlers(bot);
    await setupActionHandlers(bot);
    console.log('Handlers setup complete');

    if (process.env.NODE_ENV === 'production') {
      const domain = process.env.VERCEL_URL || process.env.DOMAIN;
      if (!domain) {
        throw new Error('VERCEL_URL or DOMAIN environment variable is not set');
      }

      await setupWebhook(domain);
      console.log('Webhook setup complete');
    } else {
      console.log('Starting bot in polling mode...');
      await bot.launch();
      console.log('Bot started in polling mode');
    }

    // Test bot connection
    const botInfo = await bot.telegram.getMe();
    console.log('Bot connection test successful:', botInfo);
  } catch (error) {
    console.error('Initialization error:', error);
    throw error;
  }
};

// Initialize on cold start
if (!bot) {
  initialize().catch(console.error);
}

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

module.exports = { handler, setupWebhook };
