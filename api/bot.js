// api/bot.js
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env' : '.env.local'
});
const config = require('../config/default');
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

let bot;
let isConnected = false;

console.log("Bot script started in", process.env.NODE_ENV, "mode");


// Helper Functions
const escapeMarkdown = (text) => {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
};

const getLatestQuizId = () => {
  const quizIds = Object.keys(quizzes).map(Number);
  return Math.max(...quizIds);
};

const initializeDatabase = async () => {
  console.log("Checking if collections are initialized...");

  const userQuizCollection = mongoose.connection.collection('userQuiz');

  // Check if the collection exists
  const count = await userQuizCollection.countDocuments();
  if (count === 0) {
      console.log("Initializing userQuiz collection...");
      
      // Create indexes if needed (optional but recommended)
      await userQuizCollection.createIndex({ userId: 1, quizId: 1 }, { unique: true });
      
      console.log("userQuiz collection initialized.");
  } else {
      console.log("userQuiz collection already exists.");
  }
};

// Function to clear leaderboard data
const clearLeaderboard = async () => {
  try {
    const userQuizCollection = mongoose.connection.collection('userQuiz');
    // Delete all documents except real user data
    const result = await userQuizCollection.deleteMany({
      userId: { $in: ["sample", undefined, null, ""] }
    });
    console.log(`Cleaned ${result.deletedCount} sample/invalid records from the database.`);
  } catch (error) {
    console.error("Error clearing leaderboard:", error);
  }
};

const connectToDatabase = async () => {
  console.log("Connecting to MongoDB...");
  try {
    if (!isConnected) {
      await mongoose.connect(config.mongodb.uri, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      isConnected = true;
      console.log('Connected to MongoDB');
      await initializeDatabase();
    }
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
};


const hasUserCompletedQuiz = async (userId) => {
  const userQuizCollection = mongoose.connection.collection('userQuiz');
  const user = await userQuizCollection.findOne({ userId, completed: true });
  return !!user;
};

// Add this near the top of your file after imports
const userSessions = new Map();

// Helper function to manage user sessions
const getUserSession = (userId) => {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      lastMessageId: null,
      currentQuizId: null,
      currentQuestionIndex: null
    });
  }
  return userSessions.get(userId);
};


// Modified sendQuizQuestion function to handle multiple users
async function sendQuizQuestion(chatId, quizId, questionIndex, userId) {
  const quiz = quizzes[quizId];
  const questionData = quiz.questions[questionIndex];
  const userSession = getUserSession(userId);

  if (!quiz || !questionData) {
    await bot.telegram.sendMessage(chatId, 'Error: Quiz or question not found.', {
      protect_content: true
    });
    return;
  }

  const messageText = [
    `📝 *Question:*\n${escapeMarkdown(questionData.question)}`,
    "",
    `🔗 [Read full article](${escapeMarkdown(questionData.link)})`
  ].join('\n');

  // Create inline buttons with proper callback data
  const buttons = questionData.options.map((option, index) => {
    const callbackData = `q${quizId}_${questionIndex}_${index}_${userId}`;  // Add userId to callback
    return Markup.button.callback(option, callbackData);
  });

  try {
    // Delete previous message if it exists
    if (userSession.lastMessageId) {
      try {
        await bot.telegram.deleteMessage(chatId, userSession.lastMessageId);
      } catch (error) {
        console.log('Could not delete previous message:', error.message);
      }
    }

    const message = await bot.telegram.sendMessage(chatId, messageText, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons.map(button => [button])),
      protect_content: true
    });

    // Update user session
    userSession.lastMessageId = message.message_id;
    userSession.currentQuizId = quizId;
    userSession.currentQuestionIndex = questionIndex;
  } catch (error) {
    console.error('Error sending quiz question:', error);
    await bot.telegram.sendMessage(chatId, 
      'Error sending quiz question\\. Please try again\\.', {
      parse_mode: 'MarkdownV2',
      protect_content: true
    });
  }
}

// Bot Command Handlers
const setupBotCommands = (bot) => {
  // Start Command
  bot.command('start', async (ctx) => {
    try {
      const hasCompleted = await hasUserCompletedQuiz(ctx.from.id);
      if (hasCompleted) {
        await ctx.reply("You have already participated in this quiz. Good luck!", {
          protect_content: true
        });
        return;
      }

      const welcomeMessage = `
Seekers, have you been following our news and Alpha recently?
Let's test that with our first Trivia Quiz!

You have until Monday, October 14th, to get a perfect score and be entered into the drawing pool to win 50 $SUI tokens!
Good luck, Seekers, and don't forget to follow us on X and Telegram to stay updated on our upcoming events! #News2Earn
      `.trim();
      
      const latestQuizId = getLatestQuizId();
      
      await ctx.replyWithPhoto(
        { url: "https://drive.google.com/uc?id=1d4bbmOQWryf1QXzRg5rfP7YKWSd0QuKn" },
        { 
          caption: welcomeMessage,
          protect_content: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎮 Start Quiz', callback_data: `start_quiz_${latestQuizId}` }]
            ]
          }
        }
      );
    } catch (error) {
      console.error('Error in start command:', error);
      await ctx.reply('Sorry, there was an error starting the quiz. Please try again.');
    }
  });

  // Help Command
  bot.command('help', async (ctx) => {
    try {
      await ctx.deleteMessage().catch(error => 
        console.log('Could not delete command message:', error.message)
      );

      const helpMessage = `📋 Available Commands:

/start - 🎮 Start the quiz game
/help - 📖 Show this help message
/listquizzes - 📝 Show available quizzes
/leaderboard - 🏆 Show top 10 players
/currentleaderboard - 📊 Show detailed leaderboard (Admin only)

📌 Usage Tips:
• Commands and responses are private
• Your quiz progress is saved automatically
• Each quiz can only be completed once`;

      await ctx.reply(helpMessage, {
        protect_content: true
      });
    } catch (error) {
      console.error("Error in help command:", error);
      await ctx.reply("An error occurred while showing help. Please try again.", {
        protect_content: true
      });
    }
  });

  // List Quizzes Command
  bot.command('listquizzes', async (ctx) => {
    try {
      await ctx.deleteMessage().catch(console.error);

      const userId = ctx.from.id;
      const userQuizCollection = mongoose.connection.collection('userQuiz');
      const completedQuizzes = await userQuizCollection.find({ userId, completed: true }).toArray();
      const completedQuizIds = completedQuizzes.map(q => q.quizId);

      let quizList = '📚 *Available Quizzes* 📚\n\n';

      for (const quizId in quizzes) {
        if (quizzes.hasOwnProperty(quizId)) {
          const isCompleted = completedQuizIds.includes(parseInt(quizId));
          const quizTitle = escapeMarkdown(quizzes[quizId].title);
          quizList += `${isCompleted ? '✅' : '🔸'} /quiz\\_${quizId} \\- ${quizTitle} ${isCompleted ? '\\(Completed\\)' : '\\(Available\\)'}\n`;
        }
      }

      await ctx.reply(quizList, { 
        parse_mode: 'MarkdownV2',
        protect_content: true
      });
    } catch (error) {
      console.error("Error in /listquizzes command:", error);
      await ctx.reply("An error occurred while listing quizzes. Please try again later.", {
        protect_content: true
      });
    }
  });

  // Leaderboard Command
  bot.command('leaderboard', async (ctx) => {
    try {
      await ctx.deleteMessage().catch(console.error);

      const userQuizCollection = mongoose.connection.collection('userQuiz');
      const leaderboard = await userQuizCollection.aggregate([
        { $group: { _id: "$userId", totalScore: { $sum: "$score" }, username: { $first: "$username" } } },
        { $sort: { totalScore: -1 } },
        { $limit: 10 }
      ]).toArray();

      let leaderboardText = '🏆 *Leaderboard* 🏆\n\n';
      leaderboard.forEach((user, index) => {
        leaderboardText += `${index + 1}. ${user.username || 'Unknown'} - ${user.totalScore} points\n`;
      });

      await ctx.reply(leaderboardText, {
        parse_mode: 'Markdown',
        protect_content: true
      });
    } catch (error) {
      console.error("Error in leaderboard command:", error);
      await ctx.reply("An error occurred while fetching the leaderboard.", {
        protect_content: true
      });
    }
  });

  // Current Leaderboard Command (Admin Only)
  bot.command('currentleaderboard', async (ctx) => {
    try {
      await ctx.deleteMessage().catch(console.error);

      if (process.env.NODE_ENV === 'local' || config.bot.adminIds.includes(ctx.from.id)) {
        const userQuizCollection = mongoose.connection.collection('userQuiz');
        const leaderboard = await userQuizCollection.find({ completed: true }).toArray();

        let leaderboardText = `📊 Detailed Leaderboard:\n\n`;
        
        if (leaderboard.length === 0) {
          leaderboardText += 'No completed quizzes yet.';
        } else {
          leaderboard.forEach((user, index) => {
            leaderboardText += `${index + 1}. TG ID: ${user.userId} - ${user.username || 'Unknown'} - ${user.score} points\n`;
          });
        }

        await ctx.reply(leaderboardText, {
          protect_content: true
        });
      } else {
        await ctx.reply("You don't have permission to use this command.", {
          protect_content: true
        });
      }
    } catch (error) {
      console.error("Error in currentleaderboard command:", error);
      await ctx.reply("An error occurred while fetching the detailed leaderboard.", {
        protect_content: true
      });
    }
  });

  // Quiz Commands
  Object.keys(quizzes).forEach(quizId => {
    bot.command(`quiz_${quizId}`, async (ctx) => {
      try {
        await ctx.deleteMessage().catch(console.error);

        if (await hasUserCompletedQuiz(ctx.from.id)) {
          await ctx.reply("You have already completed this quiz.", {
            protect_content: true
          });
          return;
        }

        await ctx.reply(`Starting quiz: ${quizzes[quizId].title}`, {
          protect_content: true
        });
        await sendQuizQuestion(ctx.chat.id, quizId, 0, ctx.from.id);
      } catch (error) {
        console.error("Error in quiz command:", error);
        await ctx.reply("An error occurred while starting the quiz.", {
          protect_content: true
        });
      }
    });
  });

  // Action Handlers
  bot.action(/^start_quiz_(\d+)$/, async (ctx) => {
    try {
      const quizId = ctx.match[1];
      const userId = ctx.from.id;

      if (await hasUserCompletedQuiz(userId)) {
        await ctx.answerCbQuery('You have already completed this quiz!');
        return;
      }

      await ctx.deleteMessage().catch(console.error);

      const quiz = quizzes[quizId];
      if (!quiz) {
        await ctx.reply('Sorry, this quiz is no longer available.', {
          protect_content: true
        });
        return;
      }

      await ctx.reply(`Starting quiz: ${quiz.title}`, {
        protect_content: true
      });
      
      await sendQuizQuestion(ctx.chat.id, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling start quiz button:', error);
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

// Modified action handler to support multiple users
bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async (ctx) => {
  try {
    const [_, quizId, questionIndex, answerIndex, userId] = ctx.match;
    
    // Verify the user is answering their own question
    if (parseInt(userId) !== ctx.from.id) {
      await ctx.answerCbQuery('This is not your quiz question!');
      return;
    }

    const userSession = getUserSession(userId);
    const quiz = quizzes[quizId];
    const questionData = quiz.questions[questionIndex];
    const userAnswer = questionData.options[answerIndex];

    await ctx.deleteMessage().catch(console.error);

    const userQuizCollection = mongoose.connection.collection('userQuiz');

    if (userAnswer === questionData.correct) {
      const messageText = [
        "✅ Correct answer\\! 🎉",
        "",
        `🔗 [Read full article](${escapeMarkdown(questionData.link)})`
      ].join('\n');

      const correctMessage = await ctx.reply(messageText, {
        parse_mode: 'MarkdownV2',
        protect_content: true
      });
      
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, correctMessage.message_id)
          .catch(console.error);
      }, 5000);

      await userQuizCollection.updateOne(
        { userId: parseInt(userId), quizId: parseInt(quizId) },
        { $inc: { score: 1 }, $set: { username: ctx.from.username } },
        { upsert: true }
      );
    } else {
      const wrongMessage = await ctx.reply([
        "❌ Wrong answer\\!",
        `The correct answer was: ${escapeMarkdown(questionData.correct)}`,
        "",
        `🔗 [Read full article](${escapeMarkdown(questionData.link)})`
      ].join('\n'), {
        parse_mode: 'MarkdownV2',
        protect_content: true
      });
      
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, wrongMessage.message_id)
          .catch(console.error);
      }, 7000);
    }

    // Add delay before next question
    setTimeout(async () => {
      const nextQuestionIndex = parseInt(questionIndex) + 1;
      if (nextQuestionIndex < quiz.questions.length) {
        await sendQuizQuestion(ctx.chat.id, quizId, nextQuestionIndex, userId);
      } else {
        // Get user's final score
        const userQuiz = await userQuizCollection.findOne({ 
          userId: parseInt(userId), 
          quizId: parseInt(quizId) 
        });
        
        const totalQuestions = quiz.questions.length;
        const userScore = userQuiz?.score || 0;
        const scorePercentage = Math.round((userScore / totalQuestions) * 100);

        const completionText = [
          `🎉 *Quiz Completed\\!*`,
          "",
          `📊 *Your Results:*`,
          `✓ Score: ${userScore}/${totalQuestions} \\(${scorePercentage}%\\)`,
          scorePercentage === 100 ? "🏆 Perfect Score\\! You're eligible for the prize draw\\!" : "Keep trying to get a perfect score\\!",
          "",
          `📋 *Available Commands:*`,
          `/help \\- Show all available commands`,
          `/listquizzes \\- Show available quizzes`,
          `/leaderboard \\- View top 10 players`,
          "",
          "Good luck\\, Seeker\\! 🍀"
        ].join('\n');

        await ctx.reply(completionText, {
          parse_mode: 'MarkdownV2',
          protect_content: true
        });
        
        await userQuizCollection.updateOne(
          { userId: parseInt(userId), quizId: parseInt(quizId) },
          { $set: { completed: true } },
          { upsert: true }
        );

        // Clear user session after quiz completion
        userSessions.delete(userId);
      }
    }, 2000);

    await ctx.answerCbQuery();
  } catch (error) {
    console.error('Error handling quiz answer:', error);
    await ctx.reply(
      'Sorry, there was an error processing your answer\\. Please try again\\.', {
      parse_mode: 'MarkdownV2',
      protect_content: true
    });
    await ctx.answerCbQuery();
  }
});

  // Set up available commands in Telegram menu
  bot.telegram.setMyCommands([
    { command: 'start', description: '🎮 Start the quiz game' },
    { command: 'help', description: '📖 Show help message' },
    { command: 'listquizzes', description: '📝 Show available quizzes' },
    { command: 'leaderboard', description: '🏆 Show top 10 players' }
  ]).catch(error => {
    console.error("Error setting bot commands:", error);
  });
};

const initializeBot = () => {
  if (!bot) {
    bot = new Telegraf(config.bot.token);
    setupBotCommands(bot); // Your existing command setup function
    
    if (process.env.NODE_ENV === 'production') {
      // In production, use webhook
      bot.telegram.setWebhook(`${process.env.API_URL}/api/bot`)
        .then(() => {
          console.log('Webhook set up successfully at:', `${process.env.API_URL}/api/bot`);
        })
        .catch(error => {
          console.error('Error setting webhook:', error);
        });
    } else {
      // In local development, use long polling
      bot.launch()
        .then(() => {
          console.log('Bot launched in long-polling mode for local development');
        })
        .catch(error => {
          console.error('Error launching bot:', error);
        });
    }
  }
};

// Export handler for API endpoint
module.exports = async (req, res) => {
  try {
    await connectToDatabase();

    if (!bot) {
      initializeBot();
    }

    if (req.method === 'POST' && process.env.NODE_ENV === 'production') {
      await bot.handleUpdate(req.body, res);
    } else {
      // For non-POST requests, return status
      res.status(200).json({ 
        status: 'Bot is running',
        mode: process.env.NODE_ENV === 'production' ? 'webhook' : 'polling',
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error in bot handler:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Start bot based on environment
if (process.env.NODE_ENV !== 'production') {
  // Only start the bot directly in non-production environment
  connectToDatabase()
    .then(() => {
      if (process.argv.includes('cleanup')) {
        console.log("Cleaning database...");
        const userQuizCollection = mongoose.connection.collection('userQuiz');
        return userQuizCollection.deleteMany({})
          .then(result => {
            console.log(`Cleaned ${result.deletedCount} records from the database.`);
            return initializeDatabase();
          })
          .then(() => {
            console.log("Database reinitialized with fresh data.");
            initializeBot();
          });
      } else {
        return initializeBot();
      }
    })
    .catch(error => {
      console.error('Failed to start bot:', error);
      process.exit(1);
    });
}
// Modified startBot function to clean sample data
const startBot = async () => {
  console.log("Starting bot in", process.env.NODE_ENV, "mode");
  
  await connectToDatabase();
  
  // Check if cleanup flag is present
  if (process.argv.includes('cleanup')) {
    try {
      console.log("Cleaning database...");
      const userQuizCollection = mongoose.connection.collection('userQuiz');
      const result = await userQuizCollection.deleteMany({});
      console.log(`Cleaned ${result.deletedCount} records from the database.`);
      
      // Initialize database without sample data
      await initializeDatabase();
      console.log("Database reinitialized.");
    } catch (error) {
      console.error("Error during cleanup:", error);
      process.exit(1);
    }
  } else {
    // Always clean sample data on regular start
    await clearLeaderboard();
  }
  
  initializeBot();
  console.log("Bot started in", process.env.NODE_ENV, "mode");
};

// Quiz Data
const quizzes = {
  1: {
    title: "First Trivia Quiz",
    questions: [
      {
        question: "What major milestone will the SWIFT network achieve in 2025?",
        options: [
          "A) SWIFT will launch its own cryptocurrency.",
          "B) SWIFT will begin trialling live digital asset and currency transactions.",
          "C) SWIFT will partner with Chainlink to create a new blockchain.",
          "D) SWIFT will become the first decentralized financial network."
        ],
        correct: "B) SWIFT will begin trialling live digital asset and currency transactions.",
        link: "https://x.com/ChainSeekers/status/1841845892196007997"
      },
      {
        question: "What are the indicators suggesting that the altcoin global market cap might be heading upwards?",
        options: [
          "A) The formation of a higher high and an ascending channel",
          "B) The combination of a recent double top and a downward breakout",
          "C) A recent double bottom, a higher low, and the breakout of a clear trendline",
          "D) The breakout of a trendline and a bearish divergence on the RSI"
        ],
        correct: "C) A recent double bottom, a higher low, and the breakout of a clear trendline",
        link: "https://x.com/ChainSeekers/status/1840738217177530477"
      },
      {
        question: "Paypal Business recently launched a crypto feature. What percentage of U.S. companies are projected to convert part of their cash reserves into Bitcoin within the next 18 months?",
        options: ["A) 5%", "B) 10%", "C) 15%", "D) 20%"],
        correct: "B) 10%",
        link: "https://x.com/ChainSeekers/status/1839299260396757500"
      },
      {
        question: "How much did Vitalik Buterin donate to charity after selling 10 billion #MOODENG?",
        options: [
          "A) 150.45 $ETH",
          "B) 260.15 $ETH",
          "C) 600.00 $ETH",
          "D) 500.10 $ETH"
        ],
        correct: "B) 260.15 $ETH",
        link: "https://x.com/ChainSeekers/status/1843278043445674456"
      },
      {
        question: "A recent collab between StepN and Adidas could drive good adoption. How many active users currently track their fitness activities via smartphones and web2 apps?",
        options: [
          "A) 50 million",
          "B) 100 million",
          "C) 200 million",
          "D) 500 million"
        ],
        correct: "C) 200 million",
        link: "https://x.com/ChainSeekers/status/1838208121505734754"
      }
    ]
  }
};

// // Start the bot
// startBot();

// // Export for API usage if needed
// module.exports = async (req, res) => {
//   await connectToDatabase();
//   initializeBot();

//   if (req.method === 'POST') {
//     await bot.handleUpdate(req.body, res);
//   } else {
//     res.status(200).send("Bot is running");
//   }
// };