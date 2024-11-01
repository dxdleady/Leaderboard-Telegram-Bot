const PQueue = require('p-queue').default;
const { escapeMarkdown } = require('../utils/helpers');
const {
  userSessions,
  getUserSession,
  hasUserCompletedQuiz,
} = require('../services/sessionManager');
const { quizzes } = require('../config/quizData');
const { Markup } = require('telegraf');
const mongoose = require('mongoose');

// Create queues for each user
const userQueues = new Map();

// Get or create queue for user
const getUserQueue = userId => {
  if (!userQueues.has(userId)) {
    userQueues.set(userId, new PQueue({ concurrency: 1 }));
  }
  return userQueues.get(userId);
};

async function sendQuizQuestion(bot, chatId, quizId, questionIndex, userId) {
  const queue = getUserQueue(userId);

  await queue.add(async () => {
    try {
      const quiz = quizzes[quizId];
      const questionData = quiz.questions[questionIndex];
      const userSession = getUserSession(userId);

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
    } catch (error) {
      console.error('Error sending quiz question:', error);
      await bot.telegram.sendMessage(
        chatId,
        'Error sending quiz question. Please try /start again.',
        {
          protect_content: true,
        }
      );
    }
  });
}

const setupActionHandlers = bot => {
  bot.action(/^start_quiz_(\d+)$/, async ctx => {
    const userId = ctx.from.id;
    const queue = getUserQueue(userId);

    await queue.add(async () => {
      try {
        const quizId = ctx.match[1];
        const chatId = ctx.chat.id;

        if (await hasUserCompletedQuiz(userId)) {
          await ctx.answerCbQuery('You have already completed this quiz!');
          return;
        }

        await ctx.deleteMessage().catch(console.error);

        const quiz = quizzes[quizId];
        if (!quiz) {
          await ctx.reply('Sorry, this quiz is no longer available.', {
            protect_content: true,
          });
          return;
        }

        await ctx.reply(`Starting quiz: ${quiz.title}`, {
          protect_content: true,
        });

        await new Promise(resolve => setTimeout(resolve, 1000));
        await sendQuizQuestion(bot, chatId, quizId, 0, userId);
        await ctx.answerCbQuery();
      } catch (error) {
        console.error('Error starting quiz:', error);
        await ctx.answerCbQuery('Error starting quiz. Please try again.');
      }
    });
  });

  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
    const userId = ctx.from.id;
    const queue = getUserQueue(userId);

    await queue.add(async () => {
      try {
        const [_, quizId, questionIndex, answerIndex] = ctx.match;
        const chatId = ctx.chat.id;

        const quiz = quizzes[quizId];
        const questionData = quiz.questions[questionIndex];
        const userAnswer = questionData.options[answerIndex];

        await ctx.deleteMessage().catch(console.error);
        const userQuizCollection = mongoose.connection.collection('userQuiz');

        if (userAnswer === questionData.correct) {
          await ctx.reply(
            `✅ Correct answer! 🎉\n\n🔗 Read full article: ${questionData.link}`,
            { protect_content: true }
          );

          await userQuizCollection.updateOne(
            { userId: parseInt(userId), quizId: parseInt(quizId) },
            { $inc: { score: 1 }, $set: { username: ctx.from.username } },
            { upsert: true }
          );
        } else {
          await ctx.reply(
            `❌ Wrong answer!\nThe correct answer was: ${questionData.correct}\n\n🔗 Read full article: ${questionData.link}`,
            { protect_content: true }
          );
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

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
          // Quiz completion
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

          userQueues.delete(userId);
        }

        await ctx.answerCbQuery();
      } catch (error) {
        console.error('Error handling answer:', error);
        await ctx.reply('Sorry, there was an error. Please try /start again.');
        await ctx.answerCbQuery();
      }
    });
  });

  return bot;
};

module.exports = {
  setupActionHandlers,
  sendQuizQuestion,
};
