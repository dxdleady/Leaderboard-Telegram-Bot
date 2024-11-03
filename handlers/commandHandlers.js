// handlers/commandHandlers.js
const { escapeMarkdown } = require('../utils/helpers');
const { getLatestQuizId } = require('../utils/helpers');
const { hasUserCompletedQuiz } = require('../services/database');
const { sendQuizQuestion } = require('../handlers/actionHandlers');
const { quizzes } = require('../config/quizData');
const mongoose = require('mongoose');
const config = require('../config/default');
const wsManager = require('../services/websocketManager');
const { Markup } = require('telegraf');

// Helper function for safe message deletion
const safeDeleteMessage = async (ctx, messageId) => {
  try {
    if (messageId) {
      await ctx.deleteMessage(messageId);
    }
  } catch (error) {
    // Ignore deletion errors and continue
    console.log(`Could not delete message ${messageId}:`, error.description);
  }
};

const setupCommandHandlers = bot => {
  bot.command('start', async ctx => {
    try {
      const userId = ctx.from.id;
      console.log('[DEBUG] Processing /start command for user:', userId);

      // Clear any existing messages for clean start
      if (ctx.message) {
        await safeDeleteMessage(
          ctx.telegram,
          ctx.chat.id,
          ctx.message.message_id
        );
      }

      const hasCompleted = await hasUserCompletedQuiz(userId);
      if (hasCompleted) {
        await ctx.reply('You have already participated in this quiz!', {
          protect_content: true,
        });
        return;
      }

      const welcomeMessage = `
  🎮 *Welcome to the Quiz Bot\\!*
  
  Seekers, have you been following our news and Alpha recently?
  Let's test that with our first Trivia Quiz\\!
  
  You have until Monday, October 14th, to get a perfect score and be entered into the drawing pool to win 50 \\$SUI tokens\\!
  Good luck, Seekers, and don't forget to follow us on X and Telegram to stay updated on our upcoming events\\! \\#News2Earn
      `.trim();

      // Send welcome message with photo
      const startMessage = await ctx.replyWithPhoto(
        {
          url: 'https://drive.google.com/uc?id=1d4bbmOQWryf1QXzRg5rfP7YKWSd0QuKn',
        },
        {
          caption: welcomeMessage,
          parse_mode: 'MarkdownV2',
          protect_content: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎮 Start Quiz',
                  callback_data: 'start_quiz_1',
                },
              ],
            ],
          },
        }
      );

      if (wsManager.isConnected(userId)) {
        wsManager.sendToUser(userId, {
          type: 'quiz_welcome',
          quizId: 1,
          messageId: startMessage.message_id,
        });
      }

      console.log('[DEBUG] Start command processed successfully');
    } catch (error) {
      console.error('[DEBUG] Error in start command:', error);
      await ctx.reply(
        'Sorry, there was an error starting the quiz. Please try again.',
        { protect_content: true }
      );
    }
  });

  // Help Command
  bot.command('help', async ctx => {
    try {
      const helpMessage = `📋 Available Commands:

/start - 🎮 Start the quiz game
/help - 📖 Show this help message
/listquizzes - 📝 Show available quizzes
/leaderboard - 🏆 Show top 10 players

📌 Usage Tips:
• Commands and responses are private
• Your quiz progress is saved automatically
• Each quiz can only be completed once`;

      await ctx.reply(helpMessage, {
        protect_content: true,
      });
    } catch (error) {
      console.error('Error in help command:', error);
      await ctx.reply(
        'An error occurred while showing help. Please try again.'
      );
    }
  });

  bot.command('listquizzes', async ctx => {
    try {
      const userId = ctx.from.id;
      const userQuizCollection = mongoose.connection.collection('userQuiz');

      console.log('[DEBUG] Getting quiz list for user:', userId);

      // Retrieve completed quizzes for the user
      const completedQuizzes = await userQuizCollection
        .find({ userId, completed: true })
        .toArray();
      const completedQuizIds = completedQuizzes.map(quiz => quiz.quizId);

      console.log('[DEBUG] Completed quizzes:', completedQuizIds);

      // Initialize quiz list message
      let quizList = '📚 *Available Quizzes*\n\n';

      // Function to escape all special characters for MarkdownV2
      const escapeSpecialChars = text => {
        return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
      };

      // Iterate over quizzes and format list with completion status
      for (const [quizId, quiz] of Object.entries(quizzes)) {
        const isCompleted = completedQuizIds.includes(parseInt(quizId));
        const statusText = isCompleted ? 'Completed' : 'Available';
        const title = escapeSpecialChars(quiz.title);

        if (isCompleted) {
          // For completed quizzes, show without link
          quizList += `✅ Quiz ${quizId} ${title} \\(${statusText}\\)\n`;
        } else {
          // For incomplete quizzes, add a clickable callback button
          quizList += `🔸 Quiz ${quizId} ${title} \\(${statusText}\\)\n`;
        }
      }

      // Add inline keyboard buttons for incomplete quizzes
      const buttons = Object.entries(quizzes)
        .filter(([quizId]) => !completedQuizIds.includes(parseInt(quizId)))
        .map(([quizId, quiz]) => [
          Markup.button.callback(
            `Start Quiz ${quizId}`,
            `start_quiz_${quizId}`
          ),
        ]);

      // Send message with inline keyboard
      await ctx.reply(quizList, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard(buttons),
        protect_content: true,
      });

      console.log('[DEBUG] Quiz list sent successfully');
    } catch (error) {
      console.error('[DEBUG] Error in listquizzes command:', error);
      await ctx.reply(
        'An error occurred while listing quizzes. Please try again.'
      );
    }
  });

  // For leaderboard command:
  bot.command('leaderboard', async ctx => {
    try {
      console.log('[DEBUG] Fetching leaderboard data...');

      const userQuizCollection = mongoose.connection.collection('userQuiz');

      // More robust aggregation pipeline
      const leaderboard = await userQuizCollection
        .aggregate([
          {
            $match: { completed: true },
          },
          {
            $group: {
              _id: '$userId',
              totalScore: { $sum: '$score' },
              quizCount: { $sum: 1 },
            },
          },
          {
            $sort: { totalScore: -1, quizCount: -1 },
          },
          {
            $limit: 10,
          },
        ])
        .toArray();

      console.log('[DEBUG] Leaderboard raw data:', leaderboard);

      if (!leaderboard || leaderboard.length === 0) {
        await ctx.reply(
          '📊 *No quiz results yet\\!*\n\nBe the first to complete a quiz and make it to the leaderboard\\! Use /start to begin\\.',
          {
            parse_mode: 'MarkdownV2',
            protect_content: true,
          }
        );
        return;
      }

      // Format leaderboard message
      let message = '🏆 *QUIZ LEADERBOARD* 🏆\n\n';

      for (let i = 0; i < leaderboard.length; i++) {
        const entry = leaderboard[i];
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🎯';
        const position = `${i + 1}`.padStart(2, ' ');

        message += `${medal} ${position}\\. User ID: ${entry._id}\n`;
        message += `    Score: ${entry.totalScore} points \\(${
          entry.quizCount
        } ${entry.quizCount === 1 ? 'quiz' : 'quizzes'}\\)\n\n`;
      }

      await ctx.reply(message, {
        parse_mode: 'MarkdownV2',
        protect_content: true,
      });

      console.log('[DEBUG] Leaderboard sent successfully');
    } catch (error) {
      console.error('[DEBUG] Leaderboard error:', error);
      await ctx.reply(
        'Sorry, there was an error fetching the leaderboard. Please try again later.'
      );
    }
  });

  // Quiz Commands
  Object.keys(quizzes).forEach(quizId => {
    bot.command(`quiz_${quizId}`, async ctx => {
      try {
        // Delete command message
        if (ctx.message) {
          await ctx.deleteMessage(ctx.message.message_id).catch(console.error);
        }

        if (await hasUserCompletedQuiz(ctx.from.id)) {
          await ctx.reply('You have already completed this quiz.', {
            protect_content: true,
          });
          return;
        }

        await ctx.reply(`Starting quiz: ${quizzes[quizId].title}`, {
          protect_content: true,
        });

        await sendQuizQuestion(bot, ctx.chat.id, quizId, 0, ctx.from.id);
      } catch (error) {
        console.error('Error in quiz command:', error);
        await ctx.reply('An error occurred while starting the quiz.', {
          protect_content: true,
        });
      }
    });
  });

  // Set up available commands in Telegram menu
  bot.telegram
    .setMyCommands([
      { command: 'start', description: '🎮 Start the quiz game' },
      { command: 'help', description: '📖 Show help message' },
      { command: 'listquizzes', description: '📝 Show available quizzes' },
      { command: 'leaderboard', description: '🏆 Show top 10 players' },
    ])
    .catch(error => {
      console.error('Error setting bot commands:', error);
    });

  return bot;
};

module.exports = setupCommandHandlers;
