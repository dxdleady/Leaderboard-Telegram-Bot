const { escapeMarkdown } = require('../utils/helpers');
const { quizzes } = require('../config/quizData');
const { Markup } = require('telegraf');
const mongoose = require('mongoose');
const { hasUserCompletedQuiz } = require('../services/database');
const wsManager = require('../services/websocketManager');

// Enhanced message deletion with retry
const safeDeleteMessage = async (bot, chatId, messageId, retries = 3) => {
  if (!messageId) return;

  for (let i = 0; i < retries; i++) {
    try {
      await bot.telegram.deleteMessage(chatId, messageId);
      return;
    } catch (error) {
      if (error.message.includes('message to delete not found')) {
        return;
      }
      if (i === retries - 1) {
        console.error('[DEBUG] Error deleting message after retries:', error);
      }
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
    }
  }
};

// Enhanced quiz question sender with error handling and retries
async function sendQuizQuestion(
  bot,
  chatId,
  quizId,
  questionIndex,
  userId,
  retries = 3
) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log('[DEBUG] Sending quiz question:', {
        quizId,
        questionIndex,
        userId,
        attempt: i + 1,
      });

      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];

      if (!quiz || !questionData) {
        throw new Error('Quiz or question not found');
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

      const sentMessage = await bot.telegram.sendMessage(chatId, messageText, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard(buttons),
        protect_content: true,
      });

      console.log(
        '[DEBUG] Question sent successfully:',
        sentMessage.message_id
      );
      return sentMessage;
    } catch (error) {
      console.error(
        `[DEBUG] Error sending quiz question (attempt ${i + 1}):`,
        error
      );
      if (i === retries - 1) {
        await bot.telegram.sendMessage(
          chatId,
          'Error sending quiz question. Please type /start to begin again.'
        );
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

const setupActionHandlers = bot => {
  // Quiz start action with session check
  bot.action(/^start_quiz_(\d+)$/, async ctx => {
    try {
      const quizId = ctx.match[1];
      const userId = ctx.from.id;
      const chatId = ctx.chat.id;

      console.log('[DEBUG] Starting quiz:', { quizId, userId, chatId });

      // Get or create user session
      const userSession = getUserSession(userId);

      // Check if user has an active quiz
      if (userSession.currentQuizId !== null) {
        await ctx.answerCbQuery(
          'You already have an active quiz. Please finish it first!'
        );
        return;
      }

      if (await hasUserCompletedQuiz(userId)) {
        await ctx.answerCbQuery('You have already completed this quiz!');
        return;
      }

      const quiz = quizzes[quizId];
      if (!quiz) {
        await ctx.reply('Sorry, this quiz is no longer available.');
        return;
      }

      // Initialize quiz session
      userSession.currentQuizId = quizId;
      userSession.currentQuestionIndex = 0;

      // Delete the start message
      if (ctx.callbackQuery.message) {
        await safeDeleteMessage(
          bot,
          chatId,
          ctx.callbackQuery.message.message_id
        );
      }

      // Send first question
      await sendQuizQuestion(bot, chatId, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('[DEBUG] Error in start_quiz action:', error);
      // Clean up session on error
      const userSession = getUserSession(ctx.from.id);
      userSession.currentQuizId = null;
      userSession.currentQuestionIndex = null;
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  // Quiz answer handling with session verification
  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    const userId = ctx.from.id;
    const userSession = getUserSession(userId);

    try {
      const [_, quizId, questionIndex, answerIndex] = ctx.match.map(Number);
      const chatId = ctx.chat.id;

      // Verify active session and question order
      if (!userSession.currentQuizId) {
        await ctx.answerCbQuery(
          'No active quiz session. Please start a new quiz.'
        );
        return;
      }

      if (
        userSession.currentQuizId !== parseInt(quizId) ||
        userSession.currentQuestionIndex !== parseInt(questionIndex)
      ) {
        await ctx.answerCbQuery('Invalid quiz state. Please start a new quiz.');
        return;
      }

      console.log('[DEBUG] Processing answer:', {
        quizId,
        questionIndex,
        answerIndex,
        userId,
      });

      // Delete the question message
      if (ctx.callbackQuery.message) {
        await safeDeleteMessage(
          bot,
          chatId,
          ctx.callbackQuery.message.message_id
        );
      }

      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];
      const userAnswer = questionData.options[answerIndex];
      const isCorrect = userAnswer === questionData.correct;

      // Update session state
      userSession.currentQuestionIndex = questionIndex + 1;

      // Update database
      const userQuizCollection = mongoose.connection.collection('userQuiz');
      if (isCorrect) {
        await userQuizCollection.updateOne(
          { userId, quizId },
          {
            $inc: { score: 1 },
            $set: { username: ctx.from.username || 'Anonymous' },
          },
          { upsert: true }
        );
      }

      // Send result message
      const resultMsg = await ctx.reply(
        isCorrect
          ? `✅ Correct answer! 🎉\n\n🔗 Read full article: ${questionData.link}`
          : `❌ Wrong answer!\nThe correct answer was: ${questionData.correct}\n\n🔗 Read full article: ${questionData.link}`,
        { protect_content: true }
      );

      // Schedule next question or end quiz
      setTimeout(async () => {
        await safeDeleteMessage(bot, chatId, resultMsg.message_id);

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
          // Quiz completion handling
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
            '/start \\- Start a new quiz',
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

          // Clear the session
          userSession.currentQuizId = null;
          userSession.currentQuestionIndex = null;
        }
      }, 2000);

      await ctx.answerCbQuery();
    } catch (error) {
      console.error('[DEBUG] Error processing answer:', error);
      // Clean up session on error
      userSession.currentQuizId = null;
      userSession.currentQuestionIndex = null;
      await ctx.reply(
        'Sorry, there was an error. Please type /start to begin again.'
      );
      await ctx.answerCbQuery();
    }
  });

  return bot;
};

module.exports = { setupActionHandlers, sendQuizQuestion };
