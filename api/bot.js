require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env' : '.env.local',
});

const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const config = require('../config/default');
const webhookHandler = require('../handlers/webhookHandlers');
const {
  connectToDatabase,
  initializeDatabase,
  clearDatabase,
} = require('../services/database');
const setupCommandHandlers = require('../handlers/commandHandlers');
const { setupActionHandlers } = require('../handlers/actionHandlers');

let bot;

const initializeBot = async () => {
  if (!bot) {
    bot = new Telegraf(config.bot.token);

    // Setup handlers
    setupCommandHandlers(bot);
    setupActionHandlers(bot);

    if (process.env.NODE_ENV === 'production') {
      // Get the actual deployment URL from environment
      const webhookUrl = `${
        process.env.VERCEL_URL || process.env.API_URL
      }/api/bot`;
      console.log('Setting webhook to:', webhookUrl);

      try {
        // First, remove any existing webhook
        await bot.telegram.deleteWebhook();

        // Set the new webhook
        await bot.telegram.setWebhook(webhookUrl, {
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true,
        });

        // Verify webhook setup
        const webhookInfo = await bot.telegram.getWebhookInfo();
        console.log('Webhook info:', webhookInfo);

        // Add some verification
        if (webhookInfo.url !== webhookUrl) {
          console.warn(
            `Warning: Webhook URL mismatch. Expected: ${webhookUrl}, Got: ${webhookInfo.url}`
          );
        }
      } catch (error) {
        console.error('Error setting webhook:', error);
        throw error;
      }
    } else {
      // Local development - use polling
      await bot.launch();
      console.log('Bot launched in polling mode for development');
    }
  }
  return bot;
};

// Modify the export handler
module.exports = async (req, res) => {
  try {
    console.log('Received webhook request:', req.method, req.url);

    await connectToDatabase();

    if (!bot) {
      await initializeBot();
    }

    if (req.method === 'POST') {
      // Log the update for debugging
      console.log('Update received:', JSON.stringify(req.body, null, 2));

      // Process the update
      await bot.handleUpdate(req.body);

      // Send response
      res.status(200).json({ ok: true });
    } else {
      // Health check
      const webhookInfo = await bot.telegram.getWebhookInfo();
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        webhook: webhookInfo,
      });
    }
  } catch (error) {
    console.error('Error in webhook handler:', error);
    // Still send 200 to Telegram
    res.status(200).json({ ok: true });
  }
};
