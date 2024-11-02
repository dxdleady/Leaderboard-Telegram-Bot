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

// Simplified handler focused on webhook functionality
const handler = async (req, res) => {
  try {
    console.log('Received request:', req.method);

    // Health check
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, status: 'healthy' });
    }

    // Handle webhook updates
    if (req.method === 'POST') {
      // Ensure bot is initialized
      if (!bot) {
        bot = initBot();
      }

      // Parse update
      let update;
      try {
        const buf = await rawBody(req);
        update = JSON.parse(buf.toString());
        console.log('Received update:', JSON.stringify(update, null, 2));
      } catch (error) {
        console.error('Error parsing update:', error);
        return res.status(200).json({ ok: true });
      }

      // Process update
      try {
        await bot.handleUpdate(update);
        console.log('Update processed successfully');
      } catch (error) {
        console.error('Error processing update:', error);
      }

      // Always return 200 to Telegram
      return res.status(200).json({ ok: true });
    }

    // Method not allowed
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Handler error:', error);
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

// Setup webhook
const setupWebhook = async domain => {
  try {
    if (!bot) {
      bot = initBot();
    }

    const webhookUrl = `https://${domain}/api/bot`;
    console.log('Setting webhook URL:', webhookUrl);

    // Remove existing webhook
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    // Set new webhook with minimal configuration
    await bot.telegram.setWebhook(webhookUrl);

    // Verify webhook
    const webhookInfo = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', webhookInfo);

    return true;
  } catch (error) {
    console.error('Webhook setup error:', error);
    return false;
  }
};

// Set webhook if not in local environment
if (process.env.VERCEL_URL && !process.env.NODE_ENV !== 'development') {
  setupWebhook(process.env.VERCEL_URL).catch(console.error);
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

module.exports = handler;
