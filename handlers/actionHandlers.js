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
      console.error('[DEBUG] Error deleting message:', error);
    }
  }
};

async function sendQuizQuestion(bot, chatId, quizId, questionIndex, userId) {
  try {
    console.log('[DEBUG] Sending quiz question:', {
      quizId,
      questionIndex,
      userId,
    });

    const quiz = quizzes[quizId];
    const questionData = quiz.questions[questionIndex];

    if (!quiz || !questionData) {
      console.error('[DEBUG] Quiz or question not found:', {
        quizId,
        questionIndex,
      });
      await bot.telegram.sendMessage(
        chatId,
        'Error: Quiz or question not found.'
      );
      return;
    }

    const messageText = [
      `📝 *Question ${questionIndex + 1} of ${quiz.questions.length}*`,
      '',
      escapeMarkdown(questionData.question),
      '',
      `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
    ].join('\n');

    const buttons = questionData.options.map((option, index) => {
      return [
        Markup.button.callback(
          option,
          `q${quizId}_${questionIndex}_${index}_${userId}`
        ),
      ];
    });

    await bot.telegram.sendMessage(chatId, messageText, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard(buttons),
      protect_content: true,
    });

    console.log('[DEBUG] Question sent successfully');
  } catch (error) {
    console.error('[DEBUG] Error sending quiz question:', error);
    await bot.telegram.sendMessage(
      chatId,
      'Error sending quiz question. Please try /start to begin again.'
    );
  }
}

const handleQuizAnswer = async (
  ctx,
  quizId,
  questionIndex,
  answerIndex,
  userId
) => {
  try {
    console.log('[DEBUG] Processing answer:', {
      quizId,
      questionIndex,
      answerIndex,
      userId,
    });

    const chatId = ctx.chat.id;
    const quiz = quizzes[quizId];
    const questionData = quiz.questions[questionIndex];
    const userAnswer = questionData.options[answerIndex];
    const isCorrect = userAnswer === questionData.correct;

    // Delete the question message
    await safeDeleteMessage(bot, chatId, ctx.callbackQuery.message.message_id);

    // Show answer result
    const resultMessage = await ctx.reply(
      isCorrect
        ? `✅ Correct answer! 🎉\n\n🔗 Read full article: ${questionData.link}`
        : `❌ Wrong answer!\nThe correct answer was: ${questionData.correct}\n\n🔗 Read full article: ${questionData.link}`,
      { protect_content: true }
    );

    // Update score in database if correct
    if (isCorrect) {
      const userQuizCollection = mongoose.connection.collection('userQuiz');
      await userQuizCollection.updateOne(
        { userId, quizId },
        {
          $inc: { score: 1 },
          $set: { username: ctx.from.username || 'Anonymous' },
        },
        { upsert: true }
      );
    }

    // Prepare for next question
    const nextQuestionIndex = questionIndex + 1;

    // Set timeout to delete result message and send next question
    setTimeout(async () => {
      await safeDeleteMessage(bot, chatId, resultMessage.message_id);

      if (nextQuestionIndex < quiz.questions.length) {
        // Send next question
        await sendQuizQuestion(bot, chatId, quizId, nextQuestionIndex, userId);
      } else {
        // Quiz completed
        const userQuizCollection = mongoose.connection.collection('userQuiz');
        const userQuiz = await userQuizCollection.findOne({ userId, quizId });
        const score = userQuiz?.score || 0;
        const totalQuestions = quiz.questions.length;
        const scorePercentage = Math.round((score / totalQuestions) * 100);

        const completionText = [
          '🎉 *Quiz Completed\\!*',
          '',
          '📊 *Your Results:*',
          `✓ Score: ${score}/${totalQuestions} \\(${scorePercentage}%\\)`,
          scorePercentage === 100
            ? "🏆 Perfect Score\\! You're eligible for the prize draw\\!"
            : 'Keep trying to get a perfect score\\!',
          '',
          '📋 *Available Commands:*',
          '/help \\- Show all available commands',
          '/listquizzes \\- Show available quizzes',
          '/leaderboard \\- View top players',
        ].join('\n');

        await ctx.reply(completionText, {
          parse_mode: 'MarkdownV2',
          protect_content: true,
        });

        // Mark quiz as completed
        await userQuizCollection.updateOne(
          { userId, quizId },
          { $set: { completed: true } },
          { upsert: true }
        );
      }
    }, 2000);

    await ctx.answerCbQuery();
  } catch (error) {
    console.error('[DEBUG] Error handling answer:', error);
    await ctx.reply(
      'Sorry, there was an error. Please try /start to begin again.'
    );
  }
};

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
