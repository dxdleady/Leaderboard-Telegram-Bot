const { escapeMarkdown } = require('../utils/helpers');
const {
  userSessions,
  getUserSession,
  hasUserCompletedQuiz,
} = require('../services/sessionManager');
const { quizzes } = require('../config/quizData');
const { Markup } = require('telegraf');
const mongoose = require('mongoose');

// Separate message queues for each user
const messageQueues = new Map();
const answerQueue = new Map();
// Helper function to get user's message queue
const getUserMessageQueue = userId => {
  if (!messageQueues.has(userId)) {
    messageQueues.set(userId, Promise.resolve());
  }
  return messageQueues.get(userId);
};

// Helper function to queue a message with proper ordering
const queueMessage = async (bot, chatId, userId, messageFunc) => {
  const queue = getUserMessageQueue(userId);
  const newQueue = queue.then(async () => {
    try {
      await messageFunc();
      // Add delay between messages
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });
  messageQueues.set(userId, newQueue);
  return newQueue;
};

async function sendQuizQuestion(bot, chatId, quizId, questionIndex, userId) {
  const quiz = quizzes[quizId];
  const questionData = quiz.questions[questionIndex];
  const userSession = getUserSession(userId);

  if (!quiz || !questionData) {
    await queueMessage(bot, chatId, userId, async () => {
      await bot.telegram.sendMessage(
        chatId,
        'Error: Quiz or question not found.',
        {
          protect_content: true,
        }
      );
    });
    return;
  }

  await queueMessage(bot, chatId, userId, async () => {
    try {
      // Delete previous message if exists
      if (userSession.lastMessageId) {
        try {
          await bot.telegram.deleteMessage(chatId, userSession.lastMessageId);
        } catch (error) {
          console.log('Could not delete previous message:', error.message);
        }
      }

      const messageText = [
        `📝 *Question ${questionIndex + 1} of ${quiz.questions.length}*`,
        '',
        escapeMarkdown(questionData.question),
        '',
        `🔗 [Read source article](${escapeMarkdown(questionData.link)})`,
      ].join('\n');

      const buttons = questionData.options.map((option, index) => {
        const callbackData = `q${quizId}_${questionIndex}_${index}_${userId}`;
        return [Markup.button.callback(option, callbackData)];
      });

      const message = await bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard(buttons),
        protect_content: true,
      });

      userSession.lastMessageId = message.message_id;
      userSession.currentQuizId = quizId;
      userSession.currentQuestionIndex = questionIndex;
    } catch (error) {
      console.error('Error sending quiz question:', error);
      await bot.telegram.sendMessage(
        chatId,
        'Error sending quiz question. Please try again.',
        {
          protect_content: true,
        }
      );
    }
  });
}

const setupActionHandlers = bot => {
  // Quiz start action
  bot.action(/^start_quiz_(\d+)$/, async ctx => {
    try {
      const quizId = ctx.match[1];
      const userId = ctx.from.id;
      const chatId = ctx.chat.id;

      if (await hasUserCompletedQuiz(userId)) {
        await ctx.answerCbQuery('You have already completed this quiz!');
        return;
      }

      await ctx.deleteMessage().catch(console.error);

      const quiz = quizzes[quizId];
      if (!quiz) {
        await queueMessage(bot, chatId, userId, async () => {
          await ctx.reply('Sorry, this quiz is no longer available.', {
            protect_content: true,
          });
        });
        return;
      }

      await queueMessage(bot, chatId, userId, async () => {
        await ctx.reply(`Starting quiz: ${quiz.title}`, {
          protect_content: true,
        });
      });

      // Small delay before first question
      await new Promise(resolve => setTimeout(resolve, 1000));
      await sendQuizQuestion(bot, chatId, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling start quiz button:', error);
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  // Replace your existing quiz answer action handler with this one
  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    try {
      const [_, quizId, questionIndex, answerIndex, userId] = ctx.match;
      const chatId = ctx.chat.id;

      if (!answerQueue.has(userId)) {
        answerQueue.set(userId, Promise.resolve());
      }

      const currentQueue = answerQueue.get(userId);
      const newQueue = currentQueue.then(async () => {
        try {
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
            const correctMessage = await ctx.reply(
              `✅ Correct answer! 🎉\n\n🔗 [Read full article](${escapeMarkdown(
                questionData.link
              )})`,
              {
                parse_mode: 'MarkdownV2',
                protect_content: true,
              }
            );

            await userQuizCollection.updateOne(
              { userId: parseInt(userId), quizId: parseInt(quizId) },
              { $inc: { score: 1 }, $set: { username: ctx.from.username } },
              { upsert: true }
            );

            setTimeout(async () => {
              await safeDeleteMessage(bot, chatId, correctMessage.message_id);
            }, 3000);
          } else {
            const wrongMessage = await ctx.reply(
              `❌ Wrong answer!\nThe correct answer was: ${escapeMarkdown(
                questionData.correct
              )}\n\n` +
                `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
              {
                parse_mode: 'MarkdownV2',
                protect_content: true,
              }
            );

            setTimeout(async () => {
              await safeDeleteMessage(bot, chatId, wrongMessage.message_id);
            }, 3000);
          }

          await new Promise(resolve => setTimeout(resolve, 3000));

          const nextQuestionIndex = parseInt(questionIndex) + 1;
          if (nextQuestionIndex < quiz.questions.length) {
            if (userSession.lastMessageId) {
              await safeDeleteMessage(bot, chatId, userSession.lastMessageId);
              userSession.lastMessageId = null;
            }
            await sendQuizQuestion(
              bot,
              chatId,
              quizId,
              nextQuestionIndex,
              userId
            );
          } else {
            const userQuiz = await userQuizCollection.findOne({
              userId: parseInt(userId),
              quizId: parseInt(quizId),
            });

            const totalQuestions = quiz.questions.length;
            const userScore = userQuiz?.score || 0;
            const scorePercentage = Math.round(
              (userScore / totalQuestions) * 100
            );

            const completionText = [
              `🎉 *Quiz Completed\\!*`,
              '',
              `📊 *Your Results:*`,
              `✓ Score: ${userScore}/${totalQuestions} \\(${scorePercentage}%\\)`,
              scorePercentage === 100
                ? "🏆 Perfect Score\\! You're eligible for the prize draw\\!"
                : 'Keep trying to get a perfect score\\!',
              '',
              `📋 *Available Commands:*`,
              `/help \\- Show all available commands`,
              `/listquizzes \\- Show available quizzes`,
              `/leaderboard \\- View top 10 players`,
            ].join('\n');

            await ctx.reply(completionText, {
              parse_mode: 'MarkdownV2',
              protect_content: true,
            });

            await userQuizCollection.updateOne(
              { userId: parseInt(userId), quizId: parseInt(quizId) },
              { $set: { completed: true } },
              { upsert: true }
            );

            userSessions.delete(userId);
            answerQueue.delete(userId);
          }

          await ctx.answerCbQuery();
        } catch (error) {
          console.error('Error processing answer:', error);
          await ctx.reply('Error processing answer. Please try again.');
        }
      });

      answerQueue.set(userId, newQueue);
      await newQueue;
    } catch (error) {
      console.error('Error in action handler:', error);
      await ctx.answerCbQuery('An error occurred. Please try again.');
    }
  });

  return bot;
};

// Helper function for safe message deletion
const safeDeleteMessage = async (bot, chatId, messageId) => {
  if (!messageId) return;
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch (error) {
    if (!error.message.includes('message to delete not found')) {
      console.error('Error deleting message:', error);
    }
  }
};

// Cleanup stale queues periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastUpdate > 30 * 60 * 1000) {
      // 30 minutes
      answerQueue.delete(userId);
    }
  }
}, 15 * 60 * 1000);

module.exports = {
  setupActionHandlers,
  sendQuizQuestion,
};
