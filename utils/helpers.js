const { quizzes } = require('../config/quizData');

const escapeMarkdown = text => {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
};

const getLatestQuizId = () => {
  const quizIds = Object.keys(quizzes).map(Number);
  return Math.max(...quizIds);
};

module.exports = {
  escapeMarkdown,
  getLatestQuizId,
};

module.exports = {
  escapeMarkdown,
  getLatestQuizId,
};
