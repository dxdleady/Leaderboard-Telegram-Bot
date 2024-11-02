// handlers/webhookHandler.js
const WebSocket = require('ws');
const wsManager = require('../services/websocketManager');
const { connectToDatabase } = require('../services/database');

const handleWebSocketUpgrade = async (req, socket, head) => {
  try {
    const userId = extractUserIdFromRequest(req);
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const wss = new WebSocket.Server({ noServer: true });

    wss.handleUpgrade(req, socket, head, ws => {
      wsManager.addConnection(userId, ws);
      console.log('WebSocket connection established for user:', userId);

      ws.on('pong', () => {
        ws.isAlive = true;
      });
    });
  } catch (error) {
    console.error('WebSocket upgrade error:', error);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
};

const extractUserIdFromRequest = req => {
  // Try to get userId from query parameters
  const urlParams = new URL(req.url, `http://${req.headers.host}`);
  const queryUserId = urlParams.searchParams.get('userId');

  // Try to get userId from headers
  const headerUserId = req.headers['x-user-id'];

  // Return the first valid userId found
  return parseInt(queryUserId || headerUserId) || null;
};

const handleUpdate = async (bot, update, userId) => {
  if (wsManager.isConnected(userId)) {
    return wsManager.queueMessage(userId, async () => {
      await bot.handleUpdate(update);
    });
  }
  return bot.handleUpdate(update);
};

const getHealthStatus = async bot => {
  try {
    const webhookInfo = await bot.telegram.getWebhookInfo();
    const activeWebSockets = wsManager.getActiveConnections();

    return {
      status: 'Bot is running',
      mode: process.env.NODE_ENV === 'production' ? 'webhook' : 'polling',
      environment: process.env.NODE_ENV,
      webhook: webhookInfo,
      activeWebSockets: activeWebSockets.length,
      activeUsers: activeWebSockets,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error getting health status:', error);
    return {
      status: 'Bot is running with errors',
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
};

const webhookHandler = async (req, res, bot) => {
  try {
    // Handle WebSocket upgrade requests
    if (
      req.headers.upgrade &&
      req.headers.upgrade.toLowerCase() === 'websocket'
    ) {
      return handleWebSocketUpgrade(req, req.socket, req.head);
    }

    // Handle health check requests
    if (req.method === 'GET') {
      const status = await getHealthStatus(bot);
      return res.status(200).json(status);
    }

    // Handle webhook updates
    if (req.method === 'POST') {
      await connectToDatabase();

      const update = req.body;
      const userId =
        update?.message?.from?.id || update?.callback_query?.from?.id;

      const timeoutMs = 8000;
      let isResponseSent = false;

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          if (!isResponseSent) {
            isResponseSent = true;
            res.status(200).json({ ok: true, timeout: true });
          }
          reject(new Error('Update processing timeout'));
        }, timeoutMs);
      });

      try {
        // Race between update handling and timeout
        await Promise.race([handleUpdate(bot, update, userId), timeoutPromise]);

        if (!isResponseSent) {
          isResponseSent = true;
          res.status(200).json({ ok: true });
        }
      } catch (error) {
        console.error('Error processing update:', error);
        if (!isResponseSent) {
          isResponseSent = true;
          res.status(200).json({ ok: true });
        }
      }
      return;
    }

    // Handle unsupported methods
    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Critical error in webhook handler:', error);
    if (!res.headersSent) {
      res.status(200).json({ ok: true, error: 'Critical error handled' });
    }
  }
};

// Implement WebSocket ping/pong for connection health monitoring
const startWebSocketHeartbeat = () => {
  setInterval(() => {
    wsManager.connections.forEach((ws, userId) => {
      if (ws.isAlive === false) {
        wsManager.removeConnection(userId);
        return;
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, 30000); // Check every 30 seconds
};

startWebSocketHeartbeat();

module.exports = webhookHandler;
