// handlers/actionHandlers.js
const { escapeMarkdown } = require('../utils/helpers');
const {
  userSessions,
  getUserSession,
  hasUserCompletedQuiz,
} = require('../services/sessionManager');
const { quizzes } = require('../config/quizData');
const { Markup } = require('telegraf');
const mongoose = require('mongoose');
const wsManager = require('../services/websocketManager');

// Safe message deletion
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

async function sendQuizQuestion(bot, chatId, quizId, questionIndex, userId) {
  const userSession = getUserSession(userId);
  const quiz = quizzes[quizId];
  const questionData = quiz.questions[questionIndex];

  // Create a promise that resolves when the message is sent
  const sendMessagePromise = new Promise(async (resolve, reject) => {
    try {
      if (!quiz || !questionData) {
        await bot.telegram.sendMessage(
          chatId,
          'Error: Quiz or question not found.',
          {
            protect_content: true,
          }
        );
        return resolve();
      }

      if (userSession.lastMessageId) {
        await safeDeleteMessage(bot, chatId, userSession.lastMessageId);
      }

      const messageText = [
        `📝 *Question ${questionIndex + 1} of ${quiz.questions.length}*`,
        '',
        escapeMarkdown(questionData.question),
        '',
        `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
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

      if (wsManager.isConnected(userId)) {
        wsManager.sendToUser(userId, {
          type: 'quiz_progress',
          currentQuestion: questionIndex + 1,
          totalQuestions: quiz.questions.length,
        });
      }

      resolve();
    } catch (error) {
      console.error('Error sending quiz question:', error);
      wsManager.clearQueue(userId);
      await bot.telegram.sendMessage(
        chatId,
        'Error sending quiz question. Please try /start to begin again.',
        { protect_content: true }
      );
      reject(error);
    }
  });

  // Queue the message sending
  await wsManager.queueMessage(userId, () => sendMessagePromise);
}

const setupActionHandlers = bot => {
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
      wsManager.clearQueue(userId); // Clear any existing queue

      const quiz = quizzes[quizId];
      if (!quiz) {
        await ctx.reply('Sorry, this quiz is no longer available.', {
          protect_content: true,
        });
        return;
      }

      // Queue the start message
      await wsManager.queueMessage(userId, async () => {
        await ctx.reply(`Starting quiz: ${quiz.title}`, {
          protect_content: true,
        });

        if (wsManager.isConnected(userId)) {
          wsManager.sendToUser(userId, {
            type: 'quiz_started',
            quizId,
            title: quiz.title,
          });
        }
      });

      // Wait a bit before sending the first question
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Send first question
      await sendQuizQuestion(bot, chatId, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling start quiz button:', error);
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  // Quiz answer action handling remains the same but with WebSocket notifications
  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    try {
      const [_, quizId, questionIndex, answerIndex, userId] = ctx.match;
      const chatId = ctx.chat.id;

      if (parseInt(userId) !== ctx.from.id) {
        await ctx.answerCbQuery('This is not your quiz question!');
        return;
      }

      wsManager.clearQueue(userId);
      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];
      const userAnswer = questionData.options[answerIndex];

      await ctx.deleteMessage().catch(console.error);
      const userQuizCollection = mongoose.connection.collection('userQuiz');

      await wsManager.queueMessage(userId, async () => {
        if (userAnswer === questionData.correct) {
          const msg = await ctx.reply(
            `✅ Correct answer! 🎉\n\n🔗 Read full article: ${questionData.link}`,
            { protect_content: true }
          );

          await userQuizCollection.updateOne(
            { userId: parseInt(userId), quizId: parseInt(quizId) },
            { $inc: { score: 1 }, $set: { username: ctx.from.username } },
            { upsert: true }
          );

          if (wsManager.isConnected(userId)) {
            wsManager.sendToUser(userId, {
              type: 'answer_result',
              correct: true,
              score: await userQuizCollection
                .findOne({ userId: parseInt(userId), quizId: parseInt(quizId) })
                .then(doc => doc.score),
            });
          }

          setTimeout(
            () => safeDeleteMessage(bot, chatId, msg.message_id),
            3000
          );
        } else {
          const msg = await ctx.reply(
            `❌ Wrong answer!\nThe correct answer was: ${questionData.correct}\n\n🔗 Read full article: ${questionData.link}`,
            { protect_content: true }
          );

          if (wsManager.isConnected(userId)) {
            wsManager.sendToUser(userId, {
              type: 'answer_result',
              correct: false,
              correctAnswer: questionData.correct,
            });
          }

          setTimeout(
            () => safeDeleteMessage(bot, chatId, msg.message_id),
            3000
          );
        }
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      const nextQuestionIndex = parseInt(questionIndex) + 1;
      if (nextQuestionIndex < quiz.questions.length) {
        await sendQuizQuestion(bot, chatId, quizId, nextQuestionIndex, userId);
      } else {
        const userQuiz = await userQuizCollection.findOne({
          userId: parseInt(userId),
          quizId: parseInt(quizId),
        });

        const totalQuestions = quiz.questions.length;
        const userScore = userQuiz?.score || 0;
        const scorePercentage = Math.round((userScore / totalQuestions) * 100);

        const completionText = [
          '🎉 *Quiz Completed\\!*',
          '',
          '📊 *Your Results:*',
          `✓ Score: ${userScore}/${totalQuestions} \\(${scorePercentage}%\\)`,
          scorePercentage === 100
            ? "🏆 Perfect Score\\! You're eligible for the prize draw\\!"
            : 'Keep trying to get a perfect score\\!',
          '',
          '📋 *Available Commands:*',
          '/help \\- Show all available commands',
          '/listquizzes \\- Show available quizzes',
          '/leaderboard \\- View top 10 players',
        ].join('\n');

        await ctx.reply(completionText, {
          parse_mode: 'MarkdownV2',
          protect_content: true,
        });

        if (wsManager.isConnected(userId)) {
          wsManager.sendToUser(userId, {
            type: 'quiz_completed',
            score: userScore,
            totalQuestions,
            scorePercentage,
            isPerfectScore: scorePercentage === 100,
          });
        }

        await userQuizCollection.updateOne(
          { userId: parseInt(userId), quizId: parseInt(quizId) },
          { $set: { completed: true } },
          { upsert: true }
        );

        wsManager.clearQueue(userId);
      }

      await ctx.answerCbQuery();
    } catch (error) {
      wsManager.clearQueue(userId);
      await ctx.reply(
        'Sorry, there was an error. Please try /start to begin again.'
      );
      await ctx.answerCbQuery();
    }
  });

  return bot;
};

module.exports = {
  setupActionHandlers,
  sendQuizQuestion,
};
