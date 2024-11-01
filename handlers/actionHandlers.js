const { escapeMarkdown } = require('../utils/helpers');
const { getUserSession, userSessions } = require('../services/sessionManager');
const { hasUserCompletedQuiz } = require('../services/database');
const { quizzes } = require('../config/quizData');
const { Markup } = require('telegraf');
const mongoose = require('mongoose');

const messageQueue = new Map();

async function sendQuizQuestion(bot, chatId, quizId, questionIndex, userId) {
  if (!messageQueue.has(userId)) {
    messageQueue.set(userId, Promise.resolve());
  }

  const currentQueue = messageQueue.get(userId);
  const newQueue = currentQueue.then(async () => {
    const quiz = quizzes[quizId];
    if (!quiz) {
      await ctx.reply('Sorry, this quiz is not available.');
      return;
    }
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
      `📝 *Question:*\n${escapeMarkdown(questionData.question)}`,
      '',
      `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
    ].join('\n');

    // Create inline buttons with proper callback data
    const buttons = questionData.options.map((option, index) => {
      const callbackData = `q${quizId}_${questionIndex}_${index}_${userId}`; // Add userId to callback
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
        protect_content: true,
      });

      // Update user session
      userSession.lastMessageId = message.message_id;
      userSession.currentQuizId = quizId;
      userSession.currentQuestionIndex = questionIndex;
    } catch (error) {
      console.error('Error sending quiz question:', error);
      await bot.telegram.sendMessage(
        chatId,
        'Error sending quiz question\\. Please try again\\.',
        {
          parse_mode: 'MarkdownV2',
          protect_content: true,
        }
      );
    }
  });

  messageQueue.set(userId, newQueue);
  return newQueue;
}

const setupActionHandlers = bot => {
  // Action Handlers
  bot.action(/^start_quiz_(\d+)$/, async ctx => {
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
          protect_content: true,
        });
        return;
      }

      await ctx.reply(`Starting quiz: ${quiz.title}`, {
        protect_content: true,
      });

      await sendQuizQuestion(bot, ctx.chat.id, quizId, 0, userId);
      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling start quiz button:', error);
      await ctx.answerCbQuery('Error starting quiz. Please try again.');
    }
  });

  // Modified action handler to support multiple users
  bot.action(/q(\d+)_(\d+)_(\d+)_(\d+)/, async ctx => {
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
          '✅ Correct answer\\! 🎉',
          '',
          `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
        ].join('\n');

        const correctMessage = await ctx.reply(messageText, {
          parse_mode: 'MarkdownV2',
          protect_content: true,
        });

        setTimeout(() => {
          ctx.telegram
            .deleteMessage(ctx.chat.id, correctMessage.message_id)
            .catch(console.error);
        }, 5000);

        await userQuizCollection.updateOne(
          { userId: parseInt(userId), quizId: parseInt(quizId) },
          { $inc: { score: 1 }, $set: { username: ctx.from.username } },
          { upsert: true }
        );
      } else {
        const wrongMessage = await ctx.reply(
          [
            '❌ Wrong answer\\!',
            `The correct answer was: ${escapeMarkdown(questionData.correct)}`,
            '',
            `🔗 [Read full article](${escapeMarkdown(questionData.link)})`,
          ].join('\n'),
          {
            parse_mode: 'MarkdownV2',
            protect_content: true,
          }
        );

        setTimeout(() => {
          ctx.telegram
            .deleteMessage(ctx.chat.id, wrongMessage.message_id)
            .catch(console.error);
        }, 7000);
      }

      // Add delay before next question
      setTimeout(async () => {
        const nextQuestionIndex = parseInt(questionIndex) + 1;
        if (nextQuestionIndex < quiz.questions.length) {
          await sendQuizQuestion(
            bot,
            ctx.chat.id,
            quizId,
            nextQuestionIndex,
            userId
          );
        } else {
          // Get user's final score
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
            '',
            'Good luck\\, Seeker\\! 🍀',
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

          // Clear user session after quiz completion
          userSessions.delete(userId);
        }
      }, 2000);

      await ctx.answerCbQuery();
    } catch (error) {
      console.error('Error handling quiz answer:', error);
      await ctx.reply(
        'Sorry, there was an error processing your answer\\. Please try again\\.',
        {
          parse_mode: 'MarkdownV2',
          protect_content: true,
        }
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
