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
  const quiz = quizzes[quizId];
  const questionData = quiz.questions[questionIndex];
  const userSession = getUserSession(userId);

  const sendQuestion = async () => {
    if (!quiz || !questionData) {
      await bot.telegram.sendMessage(
        chatId,
        'Error: Quiz or question not found.',
        {
          protect_content: true,
        }
      );
      return;
    }

    // Delete previous message if exists
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
  };

  await wsManager.queueMessage(userId, sendQuestion);
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

      wsManager.clearQueue(userId);
      await ctx.deleteMessage().catch(console.error);

      const quiz = quizzes[quizId];
      if (!quiz) {
        await ctx.reply('Sorry, this quiz is no longer available.', {
          protect_content: true,
        });
        return;
      }

      // Send start message
      await wsManager.queueMessage(userId, async () => {
        await ctx.reply(`Starting quiz: ${quiz.title}`, {
          protect_content: true,
        });
      });

      // Send first question after a delay
      await wsManager.queueMessage(userId, async () => {
        await sendQuizQuestion(bot, chatId, quizId, 0, userId);
      });

      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling start quiz button:', error);
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    try {
      const [_, quizId, questionIndex, answerIndex, userId] = ctx.match;
      const chatId = ctx.chat.id;

      if (parseInt(userId) !== ctx.from.id) {
        await ctx.answerCbQuery('This is not your quiz question!');
        return;
      }

      wsManager.clearQueue(userId);
      await ctx.deleteMessage().catch(console.error);

      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];
      const userAnswer = questionData.options[answerIndex];
      const userQuizCollection = mongoose.connection.collection('userQuiz');

      // Handle answer
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

          setTimeout(
            () => safeDeleteMessage(bot, chatId, msg.message_id),
            2000
          );
        } else {
          const msg = await ctx.reply(
            `❌ Wrong answer!\nThe correct answer was: ${questionData.correct}\n\n🔗 Read full article: ${questionData.link}`,
            { protect_content: true }
          );

          setTimeout(
            () => safeDeleteMessage(bot, chatId, msg.message_id),
            2000
          );
        }
      });

      // Send next question or completion message
      await wsManager.queueMessage(userId, async () => {
        const nextQuestionIndex = parseInt(questionIndex) + 1;
        if (nextQuestionIndex < quiz.questions.length) {
          await sendQuizQuestion(
            bot,
            chatId,
            quizId,
            nextQuestionIndex,
            userId
          );
        } else {
          // Handle quiz completion
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

          await userQuizCollection.updateOne(
            { userId: parseInt(userId), quizId: parseInt(quizId) },
            { $set: { completed: true } },
            { upsert: true }
          );
        }
      });

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
