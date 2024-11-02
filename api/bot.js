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

const connectToDatabase = async () => {
  try {
    console.log('[DEBUG] Starting database connection...');

    if (!process.env.MONGODB_URI) {
      console.error('[DEBUG] MONGODB_URI is not set in environment variables');
      throw new Error('MONGODB_URI environment variable is not set');
    }

    console.log(
      '[DEBUG] MONGODB_URI exists and starts with:',
      process.env.MONGODB_URI.substring(0, 20) + '...'
    );

    // Configure mongoose
    mongoose.set('strictQuery', false);

    const mongooseOptions = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 10000,
      heartbeatFrequencyMS: 2000,
    };

    // Set up mongoose connection event handlers
    mongoose.connection.on('connecting', () => {
      console.log('[DEBUG] MongoDB is connecting...');
    });

    mongoose.connection.on('connected', () => {
      console.log('[DEBUG] MongoDB connected successfully!');
    });

    mongoose.connection.on('disconnected', () => {
      console.error('[DEBUG] MongoDB disconnected!');
    });

    mongoose.connection.on('error', err => {
      console.error('[DEBUG] MongoDB connection error:', err);
    });

    console.log('[DEBUG] Attempting to connect to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI, mongooseOptions);

    const connectionState = mongoose.connection.readyState;
    console.log('[DEBUG] Connection state after connect:', connectionState);

    if (connectionState !== 1) {
      throw new Error(
        `Failed to connect to MongoDB. Connection state: ${connectionState}`
      );
    }

    console.log('[DEBUG] MongoDB connection verified and ready!');
    return true;
  } catch (error) {
    console.error('[DEBUG] Database connection error full details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      name: error.name,
    });
    throw error;
  }
};

const setupWebhook = async domain => {
  try {
    if (!bot) {
      console.error('[DEBUG] Bot not initialized during webhook setup');
      return false;
    }

    const webhookUrl = `https://${domain}/api/bot`;
    console.log('[DEBUG] Setting webhook URL:', webhookUrl);

    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
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

    // Always attempt to connect to database if not connected
    if (mongoose.connection.readyState !== 1) {
      console.log(
        '[DEBUG] Database not connected. Current state:',
        mongoose.connection.readyState
      );
      await connectToDatabase();

      if (process.argv.includes('cleanup')) {
        console.log('[DEBUG] Running database cleanup...');
        await clearDatabase();
      }

      await initializeDatabase();
    }

    console.log('[DEBUG] Final database state:', {
      readyState: mongoose.connection.readyState,
      host: mongoose.connection.host,
      name: mongoose.connection.name,
    });

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

const startPolling = async () => {
  try {
    console.log('[DEBUG] Starting bot in polling mode...');
    await bot.launch({
      dropPendingUpdates: true,
      polling: {
        timeout: 30,
        limit: 100,
      },
    });
    console.log('[DEBUG] Bot is running in polling mode');

    process.once('SIGINT', () => {
      console.log('[DEBUG] SIGINT received, stopping bot...');
      bot.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      console.log('[DEBUG] SIGTERM received, stopping bot...');
      bot.stop('SIGTERM');
    });

    return true;
  } catch (error) {
    console.error('[DEBUG] Error starting polling mode:', error);
    throw error;
  }
};

const handler = async (request, response) => {
  try {
    console.log('[DEBUG] Received request:', request.method);

    if (request.method === 'GET') {
      // Try to connect if disconnected
      if (mongoose.connection.readyState !== 1) {
        console.log(
          '[DEBUG] Database disconnected during health check, attempting connection...'
        );
        await connectToDatabase();
      }

      const health = {
        ok: true,
        timestamp: new Date().toISOString(),
        database: {
          state: mongoose.connection.readyState,
          stateString:
            ['disconnected', 'connected', 'connecting', 'disconnecting'][
              mongoose.connection.readyState
            ] || 'unknown',
          host: mongoose.connection.host,
          name: mongoose.connection.name,
          uri: process.env.MONGODB_URI
            ? `${process.env.MONGODB_URI.substring(0, 20)}...`
            : 'not set',
        },
        botInitialized: !!bot,
        environment: process.env.NODE_ENV,
        vercelUrl: process.env.VERCEL_URL,
      };

      console.log(
        '[DEBUG] Health check details:',
        JSON.stringify(health, null, 2)
      );
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

// Configure serverless function
handler.config = {
  api: {
    bodyParser: false,
  },
};

// Initialize based on environment
if (require.main === module) {
  // Running directly (local development)
  initializeServices()
    .then(() => startPolling())
    .catch(error => {
      console.error(
        '[DEBUG] Failed to initialize for local development:',
        error
      );
      process.exit(1);
    });
} else if (process.env.VERCEL_URL && process.env.NODE_ENV === 'production') {
  // Running on Vercel production
  console.log('[DEBUG] Production environment detected, setting up webhook...');
  initializeServices()
    .then(() => setupWebhook(process.env.VERCEL_URL))
    .then(success => {
      if (success) {
        console.log('[DEBUG] Webhook setup complete');
      } else {
        console.error('[DEBUG] Webhook setup failed');
      }
    })
    .catch(error => {
      console.error('[DEBUG] Production initialization error:', error);
    });
}

module.exports = handler;
