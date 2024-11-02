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
  try {
    const userSession = getUserSession(userId);
    const quiz = quizzes[quizId];
    const questionData = quiz.questions[questionIndex];

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
      wsManager.updateQuizProgress(userId, {
        questionIndex: questionIndex + 1,
        totalQuestions: quiz.questions.length,
        quizId,
        quizTitle: quiz.title,
      });
    }
  } catch (error) {
    console.error('Error sending quiz question:', error);
    await bot.telegram.sendMessage(
      chatId,
      'Error sending quiz question. Please try /start to begin again.',
      { protect_content: true }
    );
  }
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

      const quiz = quizzes[quizId];
      if (!quiz) {
        await ctx.reply('Sorry, this quiz is no longer available.', {
          protect_content: true,
        });
        return;
      }

      // Only delete the button message, not the entire chat history
      await ctx
        .deleteMessage(ctx.callbackQuery.message.message_id)
        .catch(console.error);

      // Start the quiz without repeating the welcome message
      await sendQuizQuestion(bot, chatId, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling start quiz button:', error);
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  // Quiz answer action
  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    try {
      const [_, quizId, questionIndex, answerIndex, userId] =
        ctx.match.map(Number);
      const chatId = ctx.chat.id;

      if (userId !== ctx.from.id) {
        await ctx.answerCbQuery('This is not your quiz question!');
        return;
      }

      // Delete only the question message
      await ctx
        .deleteMessage(ctx.callbackQuery.message.message_id)
        .catch(console.error);

      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];
      const userAnswer = questionData.options[answerIndex];
      const userQuizCollection = mongoose.connection.collection('userQuiz');

      const isCorrect = userAnswer === questionData.correct;

      // Show answer result
      const resultMsg = await ctx.reply(
        isCorrect
          ? `✅ Correct answer! 🎉\n\n🔗 Read full article: ${questionData.link}`
          : `❌ Wrong answer!\nThe correct answer was: ${questionData.correct}\n\n🔗 Read full article: ${questionData.link}`,
        { protect_content: true }
      );

      if (isCorrect) {
        await userQuizCollection.updateOne(
          { userId, quizId },
          { $inc: { score: 1 }, $set: { username: ctx.from.username } },
          { upsert: true }
        );
      }

      // Delete result message after delay
      setTimeout(
        () => safeDeleteMessage(bot, chatId, resultMsg.message_id),
        2000
      );

      // Notify WebSocket if connected
      if (wsManager.isConnected(userId)) {
        wsManager.sendToUser(userId, {
          type: 'answer_result',
          correct: isCorrect,
          questionIndex: questionIndex + 1,
          totalQuestions: quiz.questions.length,
          correctAnswer: questionData.correct,
        });
      }

      // Process next question or quiz completion after delay
      setTimeout(async () => {
        const nextQuestionIndex = questionIndex + 1;
        if (nextQuestionIndex < quiz.questions.length) {
          await sendQuizQuestion(
            bot,
            chatId,
            quizId,
            nextQuestionIndex,
            userId
          );
        } else {
          const userQuiz = await userQuizCollection.findOne({ userId, quizId });
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
            { userId, quizId },
            { $set: { completed: true } },
            { upsert: true }
          );

          if (wsManager.isConnected(userId)) {
            wsManager.sendToUser(userId, {
              type: 'quiz_completed',
              score: userScore,
              totalQuestions,
              scorePercentage,
              isPerfectScore: scorePercentage === 100,
            });
          }
        }
      }, 2500);

      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling answer:', error);
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
