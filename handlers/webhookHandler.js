const {
  activeConnections,
  manageConnection,
} = require('../services/sessionManager');
const { connectToDatabase } = require('../services/database');

const webhookHandler = async (req, res, bot) => {
  try {
    console.log('Received webhook request:', req.method);

    // Extract user ID from update
    const update = req.body;
    const userId =
      update?.message?.from?.id || update?.callback_query?.from?.id;
    console.log('Update from user:', userId);

    // Ensure database connection
    await connectToDatabase();

    if (req.method === 'POST') {
      // Set response timeout
      const timeoutMs = 8000; // 8 seconds
      let isResponseSent = false;

      // Create timeout handler
      const timeoutHandler = setTimeout(() => {
        if (!isResponseSent) {
          isResponseSent = true;
          console.log('Sending timeout response for user:', userId);
          res.status(200).json({ ok: true, timeout: true });
        }
      }, timeoutMs);

      try {
        // Track active connection
        if (userId) {
          await manageConnection(userId, 'add');
          console.log('Added active connection for user:', userId);
        }

        // Process the update with timeout
        await Promise.race([
          bot.handleUpdate(update).then(() => {
            if (!isResponseSent) {
              isResponseSent = true;
              clearTimeout(timeoutHandler);
              res.status(200).json({ ok: true });
            }
          }),
          new Promise((_, reject) => {
            setTimeout(
              () => reject(new Error('Update processing timeout')),
              timeoutMs
            );
          }),
        ]);
      } catch (error) {
        console.error('Error processing update:', error);
        if (!isResponseSent) {
          isResponseSent = true;
          clearTimeout(timeoutHandler);
          res.status(200).json({ ok: true }); // Still send OK to Telegram
        }
      } finally {
        // Cleanup
        if (userId) {
          await manageConnection(userId, 'remove');
          console.log('Removed active connection for user:', userId);
        }
        if (!isResponseSent) {
          clearTimeout(timeoutHandler);
          res.status(200).json({ ok: true });
        }
      }
    } else {
      // Health check endpoint
      try {
        const webhookInfo = await bot.telegram.getWebhookInfo();
        const activeUsers = Array.from(activeConnections.keys());

        res.status(200).json({
          status: 'Bot is running',
          mode: process.env.NODE_ENV === 'production' ? 'webhook' : 'polling',
          environment: process.env.NODE_ENV,
          webhook: webhookInfo,
          activeConnections: activeUsers.length,
          activeUsers: activeUsers,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error('Error in health check:', error);
        res.status(200).json({
          status: 'Bot is running',
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    console.error('Critical error in webhook handler:', error);
    // Ensure we always send a response
    if (!res.headersSent) {
      res.status(200).json({ ok: true, error: 'Critical error handled' });
    }
  }
};

// Add periodic cleanup of stale connections
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamp] of activeConnections.entries()) {
    if (now - timestamp > 30000) {
      // 30 seconds timeout
      manageConnection(userId, 'remove')
        .then(() =>
          console.log('Cleaned up stale connection for user:', userId)
        )
        .catch(error => console.error('Error cleaning up connection:', error));
    }
  }
}, 10000); // Check every 10 seconds

module.exports = webhookHandler;
