// handlers/commandHandlers.js
const { escapeMarkdown } = require('../utils/helpers');
const { getLatestQuizId } = require('../utils/helpers');
const { hasUserCompletedQuiz } = require('../services/database');
const { sendQuizQuestion } = require('../handlers/actionHandlers');
const { quizzes } = require('../config/quizData');
const mongoose = require('mongoose');
const config = require('../config/default');
const wsManager = require('../services/websocketManager');

const setupCommandHandlers = bot => {
  // Start command handler
  bot.command('start', async ctx => {
    try {
      const userId = ctx.from.id;
      const hasCompleted = await hasUserCompletedQuiz(userId);

      if (hasCompleted) {
        await ctx.reply(
          'You have already participated in this quiz. Good luck!',
          {
            protect_content: true,
          }
        );
        return;
      }

      // Delete the command message
      if (ctx.message) {
        await ctx.deleteMessage(ctx.message.message_id).catch(console.error);
      }

      const welcomeMessage = `
Seekers, have you been following our news and Alpha recently?
Let's test that with our first Trivia Quiz!

You have until Monday, October 14th, to get a perfect score and be entered into the drawing pool to win 50 $SUI tokens!
Good luck, Seekers, and don't forget to follow us on X and Telegram to stay updated on our upcoming events! #News2Earn
      `.trim();

      const latestQuizId = getLatestQuizId();

      // Send welcome message with photo
      await ctx.replyWithPhoto(
        {
          url: 'https://drive.google.com/uc?id=1d4bbmOQWryf1QXzRg5rfP7YKWSd0QuKn',
        },
        {
          caption: welcomeMessage,
          protect_content: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎮 Start Quiz',
                  callback_data: `start_quiz_${latestQuizId}`,
                },
              ],
            ],
          },
        }
      );

      if (wsManager.isConnected(userId)) {
        wsManager.sendToUser(userId, {
          type: 'quiz_welcome',
          quizId: latestQuizId,
        });
      }
    } catch (error) {
      console.error('Error in start command:', error);
      await ctx.reply(
        'Sorry, there was an error starting the quiz. Please try again.'
      );
    }
  });

  // Help Command
  bot.command('help', async ctx => {
    try {
      // Delete command message
      if (ctx.message) {
        await ctx.deleteMessage(ctx.message.message_id).catch(console.error);
      }

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
        'An error occurred while showing help. Please try again.',
        {
          protect_content: true,
        }
      );
    }
  });

  // List Quizzes Command
  bot.command('listquizzes', async ctx => {
    try {
      // Delete command message
      if (ctx.message) {
        await ctx.deleteMessage(ctx.message.message_id).catch(console.error);
      }

      const userId = ctx.from.id;
      const userQuizCollection = mongoose.connection.collection('userQuiz');
      const completedQuizzes = await userQuizCollection
        .find({ userId, completed: true })
        .toArray();
      const completedQuizIds = completedQuizzes.map(q => q.quizId);

      let quizList = '📚 *Available Quizzes* 📚\n\n';

      for (const quizId in quizzes) {
        if (quizzes.hasOwnProperty(quizId)) {
          const isCompleted = completedQuizIds.includes(parseInt(quizId));
          const quizTitle = escapeMarkdown(quizzes[quizId].title);
          quizList += `${
            isCompleted ? '✅' : '🔸'
          } /quiz\\_${quizId} \\- ${quizTitle} ${
            isCompleted ? '\\(Completed\\)' : '\\(Available\\)'
          }\n`;
        }
      }

      await ctx.reply(quizList, {
        parse_mode: 'MarkdownV2',
        protect_content: true,
      });

      if (wsManager.isConnected(userId)) {
        wsManager.sendToUser(userId, {
          type: 'quiz_list',
          completedQuizzes: completedQuizIds,
        });
      }
    } catch (error) {
      console.error('Error in /listquizzes command:', error);
      await ctx.reply(
        'An error occurred while listing quizzes. Please try again later.',
        {
          protect_content: true,
        }
      );
    }
  });

  // Leaderboard Command
  bot.command('leaderboard', async ctx => {
    try {
      // Delete command message
      if (ctx.message) {
        await ctx.deleteMessage(ctx.message.message_id).catch(console.error);
      }

      const userQuizCollection = mongoose.connection.collection('userQuiz');
      const leaderboard = await userQuizCollection
        .aggregate([
          {
            $group: {
              _id: '$userId',
              totalScore: { $sum: '$score' },
              username: { $first: '$username' },
            },
          },
          { $sort: { totalScore: -1 } },
          { $limit: 10 },
        ])
        .toArray();

      let leaderboardText = '🏆 *Leaderboard* 🏆\n\n';
      leaderboard.forEach((user, index) => {
        leaderboardText += `${index + 1}. ${user.username || 'Unknown'} - ${
          user.totalScore
        } points\n`;
      });

      await ctx.reply(leaderboardText, {
        parse_mode: 'Markdown',
        protect_content: true,
      });

      if (wsManager.isConnected(ctx.from.id)) {
        wsManager.sendToUser(ctx.from.id, {
          type: 'leaderboard_update',
          leaderboard: leaderboard,
        });
      }
    } catch (error) {
      console.error('Error in leaderboard command:', error);
      await ctx.reply('An error occurred while fetching the leaderboard.', {
        protect_content: true,
      });
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
